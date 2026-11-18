import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDb } from './support/db.ts';
import { skipCase, titleOf } from './support/cases.ts';
import { createE2eHome } from './support/home.ts';
import type { E2eHome } from './support/home.ts';
import { TOOL_GROUPS_SQL } from './support/ledger.ts';
import { expectEndedAtTerminal, groupRunning } from './support/process.ts';
import { createRuntimeClient, framesOfType } from './support/runtime-client.ts';
import type { RuntimeClient } from './support/runtime-client.ts';
import { platformSandbox, sandboxOrSkip } from './support/sandbox.ts';
import { shutdownBarrier, startStack } from './support/stack.ts';
import { chatCompletions, hangReply, toolCallReply } from './support/upstream.ts';
import {
  E2E_CANCEL_KILL_BOUND_MS,
  E2E_CANCEL_STREAM_BOUND_MS,
  E2E_CANCEL_TERM_BOUND_MS,
  E2E_MARGIN_MS,
  E2E_RECOVERY_BOUND_MS,
  E2E_TEST_TIMEOUT_MS,
  until,
  E2E_RUN_COMPLETED_BOUND_MS,
} from './support/wait.ts';

const PARTIAL_TEXT = 'partial';
const TERM_RECEIVED_FILE = 'term-received';
const TRAP_READY_FILE = 'trap-ready';

const toolGroupsOf = (home: E2eHome): number[] =>
  readDb<{ pgid: number }>(home.paths.databases.runtime, TOOL_GROUPS_SQL).map((row) => Number(row.pgid));

const runRowOf = (home: E2eHome, runId: string) =>
  readDb<{ status: string; lease_owner: string | null }>(home.paths.databases.runtime, 'SELECT status, lease_owner FROM runs WHERE id = ?', runId)[0];

const untilStatus = async (runtime: RuntimeClient, runId: string, status: string, deadlineMs: number): Promise<void> => {
  await until(async () => (await runtime.getRun(runId)).run.status === status, { deadlineMs, description: `run ${runId} is ${status}` });
};

const cancelDuringBash = async (command: string, cancelBoundMs: number): Promise<{ project: string }> => {
  const home = await createE2eHome();
  const stack = await startStack({ home, needsBash: true, script: [toolCallReply('Bash', { command })] });
  expect(stack.sandbox).toBe(platformSandbox());
  const runtime = createRuntimeClient(home);
  try {
    const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
    const { run } = await runtime.createRun(session.id, 'Say hello');
    const pgid = await until(() => toolGroupsOf(home)[0], { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'idempotency row with a pgid' });
    expect(await groupRunning(pgid)).toBe(true);
    await until(() => fs.existsSync(path.join(home.project, TRAP_READY_FILE)), { deadlineMs: E2E_RECOVERY_BOUND_MS, description: 'the command installed its TERM trap' });
    expect((await runtime.getRun(run.id)).run.status).not.toBe('CANCELLED');

    const cancelled = await runtime.cancel(run.id);
    expect(cancelled.status).toBe(202);
    expect(cancelled.run.cancelRequested).toBe(true);

    await untilStatus(runtime, run.id, 'CANCELLED', cancelBoundMs);
    await expectEndedAtTerminal('CANCELLED', { group: pgid });

    const stream = runtime.events(run.id);
    const frames = await stream.toEnd(E2E_MARGIN_MS);
    await stream.close();
    expect(frames.at(-1)?.data.type).toBe('run.status');
    expect(frames.at(-1)?.data.to).toBe('CANCELLED');
    expect(framesOfType(frames, 'run.status').some((frame) => frame.data.to === 'COMPLETED')).toBe(false);
    expect(framesOfType(frames, 'tool.reconciled').map((frame) => ({ interrupted: frame.data.interrupted, outcome: frame.data.outcome }))).toEqual([{ interrupted: 'cancelled', outcome: 'unknown' }]);
    expect(framesOfType(frames, 'model.requested')).toHaveLength(1);

    await shutdownBarrier(stack);
    expect(chatCompletions(stack.fake)).toHaveLength(1);
    expect(readDb<{ state: string }>(home.paths.databases.runtime, 'SELECT state FROM idempotency').map((row) => row.state)).toEqual(['COMPLETED']);
    return { project: home.project };
  } finally {
    await runtime.close();
  }
};

describe('c: cancel', () => {
  it.skipIf(skipCase('c1'))(titleOf('c1'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const { project } = await cancelDuringBash(`trap ': > ${TERM_RECEIVED_FILE}; exit 143' TERM; : > ${TRAP_READY_FILE}; sleep 30 & wait`, E2E_CANCEL_TERM_BOUND_MS);
    expect(fs.existsSync(path.join(project, TERM_RECEIVED_FILE))).toBe(true);
  });

  it.skipIf(skipCase('c1b'))(titleOf('c1b'), { timeout: E2E_TEST_TIMEOUT_MS }, async (context) => {
    sandboxOrSkip(context);
    const { project } = await cancelDuringBash(`trap ': > ${TERM_RECEIVED_FILE}' TERM; : > ${TRAP_READY_FILE}; while :; do sleep 1; done`, E2E_CANCEL_KILL_BOUND_MS);
    expect(fs.existsSync(path.join(project, TERM_RECEIVED_FILE)), 'the command was asked with SIGTERM first, ignored it, and was killed').toBe(true);
  });

  it(titleOf('c2'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home, script: [hangReply(PARTIAL_TEXT)] });
    const runtime = createRuntimeClient(home);
    try {
      const { session } = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const { run } = await runtime.createRun(session.id, 'Say hello');
      const stream = runtime.events(run.id);
      const delta = await stream.until((frame) => frame.data.type === 'agent.message.delta', E2E_RECOVERY_BOUND_MS);
      expect(delta.data.text).toBe(PARTIAL_TEXT);
      expect(stack.fake.openConnections()).toBe(1);
      const disconnectsBefore = stack.fake.disconnects();

      const cancelled = await runtime.cancel(run.id);
      expect(cancelled.status).toBe(202);
      await untilStatus(runtime, run.id, 'CANCELLED', E2E_CANCEL_STREAM_BOUND_MS);
      await until(() => stack.fake.openConnections() === 0 && stack.fake.disconnects() > disconnectsBefore, {
        deadlineMs: E2E_CANCEL_STREAM_BOUND_MS,
        description: 'the upstream connection was cut',
      });

      const frames = await stream.toEnd(E2E_MARGIN_MS);
      await stream.close();
      expect(frames.at(-1)?.data.type).toBe('run.status');
      expect(frames.at(-1)?.data.to).toBe('CANCELLED');
      expect(framesOfType(frames, 'model.responded')).toEqual([]);

      await shutdownBarrier(stack);
      expect(chatCompletions(stack.fake)).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it(titleOf('c3'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const stack = await startStack({ home });
    const runtime = createRuntimeClient(home);
    const hold = stack.fake.hold();
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      hold.release();
    };
    try {
      const first = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      const runA = (await runtime.createRun(first.session.id, 'Say hello')).run;
      await hold.waitForRequest({ timeoutMs: E2E_RUN_COMPLETED_BOUND_MS, description: 'the held model request' });

      const second = await runtime.createSession({ permissionMode: 'bypassPermissions' });
      expect(second.session.id).not.toBe(first.session.id);
      const runB = (await runtime.createRun(second.session.id, 'Say hello')).run;
      expect((await runtime.getRun(runB.id)).run.status).toBe('QUEUED');

      const cancelled = await runtime.cancel(runB.id);
      expect(cancelled.status).toBe(202);
      await untilStatus(runtime, runB.id, 'CANCELLED', E2E_CANCEL_TERM_BOUND_MS);
      const rowB = await until(() => runRowOf(home, runB.id), { deadlineMs: E2E_MARGIN_MS, description: `run ${runB.id} row readable` });
      expect(rowB.status).toBe('CANCELLED');
      expect(rowB.lease_owner).toBeNull();
      expect((await runtime.getRun(runA.id)).run.status).toBe('RUNNING');

      const streamB = runtime.events(runB.id);
      const framesB = await streamB.toEnd(E2E_MARGIN_MS);
      await streamB.close();
      expect(framesB.at(-1)?.data.to).toBe('CANCELLED');
      expect(framesOfType(framesB, 'model.requested')).toEqual([]);
      expect(framesOfType(framesB, 'run.status').map((frame) => frame.data.to)).not.toContain('RUNNING');

      releaseOnce();
      const streamA = runtime.events(runA.id);
      const framesA = await streamA.toEnd(E2E_RECOVERY_BOUND_MS);
      await streamA.close();
      expect(framesA.at(-1)?.data.to).toBe('COMPLETED');

      await shutdownBarrier(stack);
      const calls = chatCompletions(stack.fake);
      expect(calls).toHaveLength(1);
    } finally {
      releaseOnce();
      await runtime.close();
    }
  });
});
