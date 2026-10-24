import { describe, expect, it } from 'vitest';
import { FAKE_DETERMINISTIC_REPLY } from '@momonga/testkit';
import { titleOf } from './support/cases.ts';
import { readDb } from './support/db.ts';
import { createE2eHome } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { createRuntimeClient, framesOfType } from './support/runtime-client.ts';
import { DEFAULT_E2E_DEPS, startStack } from './support/stack.ts';
import type { E2eStack } from './support/stack.ts';
import { childOf } from './support/supervisor-client.ts';
import { chatCompletions } from './support/upstream.ts';
import { E2E_MARGIN_MS, E2E_RECOVERY_BOUND_MS, E2E_RESTART_BOUND_MS, E2E_RESTART_POLICY, E2E_TEST_TIMEOUT_MS, until } from './support/wait.ts';

type ReleaseTiming = 'after-claim' | 'while-down';

const leaseOwnerOf = (home: E2eHome, runId: string): string | null | undefined =>
  readDb<{ lease_owner: string | null }>(home.paths.databases.runtime, 'SELECT lease_owner FROM runs WHERE id = ?', runId)[0]?.lease_owner;

const runRowOf = (home: E2eHome, runId: string) =>
  readDb<{ status: string; lease_owner: string | null }>(home.paths.databases.runtime, 'SELECT status, lease_owner FROM runs WHERE id = ?', runId)[0];

const killRuntimeDuringModelCall = async (release: ReleaseTiming): Promise<void> => {
  const home = await createE2eHome();
  const stack: E2eStack = await startStack({ home, deps: { ...DEFAULT_E2E_DEPS, restart: E2E_RESTART_POLICY } });
  const runtime = createRuntimeClient(home);
  const hold = stack.fake.hold();
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    hold.release();
  };
  try {
    const { session } = await runtime.createSession();
    const { run } = await runtime.createRun(session.id, 'Say hello');
    await hold.waitForRequest();

    const before = await stack.client.health();
    const oldRuntime = childOf(before, 'runtime');
    const oldGateway = childOf(before, 'gateway');
    expect(oldRuntime.state).toBe('ready');
    expect(oldRuntime.restarts).toBe(0);
    const oldRuntimePid = oldRuntime.pid;
    if (oldRuntimePid === undefined) throw new Error('runtime has no pid');
    const oldOwner = await until(() => leaseOwnerOf(home, run.id), { deadlineMs: E2E_MARGIN_MS, description: `run ${run.id} lease owner readable` });
    expect(oldOwner).toMatch(new RegExp(`^runtime-${oldRuntimePid}-`));

    process.kill(oldRuntimePid, 'SIGKILL');
    if (release === 'while-down') releaseOnce();

    const newRuntime = await stack.client.untilChild(
      'runtime',
      (child) => child.state === 'ready' && child.pid !== undefined && child.pid !== oldRuntimePid && child.restarts === 1,
      E2E_RESTART_BOUND_MS,
    );
    const newRuntimePid = newRuntime.pid;
    if (newRuntimePid === undefined) throw new Error('restarted runtime has no pid');

    await until(
      () => {
        const row = runRowOf(home, run.id);
        if (row === undefined) return false;
        const claimedByNewRuntime = row.status === 'RUNNING' && row.lease_owner !== null && row.lease_owner.startsWith(`runtime-${newRuntimePid}-`);
        return claimedByNewRuntime || (release === 'while-down' && row.status === 'COMPLETED');
      },
      { deadlineMs: E2E_RECOVERY_BOUND_MS, description: `run ${run.id} claimed by runtime ${newRuntimePid}` },
    );

    releaseOnce();

    const stream = runtime.events(run.id);
    const frames = await stream.toEnd(E2E_MARGIN_MS);
    await stream.close();

    const last = frames.at(-1);
    expect(last?.data.type).toBe('run.status');
    expect(last?.data.to).toBe('COMPLETED');
    expect(framesOfType(frames, 'run.status').filter((frame) => frame.data.to === 'COMPLETED')).toHaveLength(1);
    expect(chatCompletions(stack.fake)).toHaveLength(1);
    expect(framesOfType(frames, 'model.requested')).toHaveLength(1);
    expect(framesOfType(frames, 'model.responded')).toHaveLength(1);
    expect(framesOfType(frames, 'agent.message.delta').map((frame) => frame.data.text).join('')).toBe(FAKE_DETERMINISTIC_REPLY);
    expect(frames.map((frame) => frame.data.seq)).toEqual([...frames.map((frame) => frame.data.seq)].sort((a, b) => a - b));
    expect(new Set(frames.map((frame) => frame.data.seq)).size).toBe(frames.length);

    const final = await runtime.getRun(run.id);
    expect(final.run.status).toBe('COMPLETED');
    expect(final.run.step).toBe(1);

    const after = await stack.client.health();
    const gatewayAfter = childOf(after, 'gateway');
    expect(gatewayAfter.pid).toBe(oldGateway.pid);
    expect(gatewayAfter.restarts).toBe(0);
    expect(childOf(after, 'runtime').pid).toBe(newRuntimePid);
  } finally {
    releaseOnce();
    await runtime.close();
  }
};

describe('b1: kill the runtime during the model call', () => {
  it(titleOf('b1-join'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    await killRuntimeDuringModelCall('after-claim');
  });

  it(titleOf('b1-replay'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    await killRuntimeDuringModelCall('while-down');
  });
});
