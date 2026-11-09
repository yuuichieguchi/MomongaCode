import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, DAEMON_PROCESS_TEST_TIMEOUT_MS, FAKE_DETERMINISTIC_REPLY } from '@momonga/testkit';
import { launchRuntime, readDb, startStack } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const control = vi.hoisted(() => ({ serviceNames: [] as string[] }));

vi.mock('@momonga/observability', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/observability')>();
  return {
    ...original,
    createTelemetry: (options: Parameters<typeof original.createTelemetry>[0]) => {
      control.serviceNames.push(options.serviceName);
      return original.createTelemetry(options);
    },
  };
});

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };

beforeEach(() => {
  control.serviceNames = [];
});

const leaseOwners = (dbPath: string): (string | null)[] =>
  readDb<{ lease_owner: string | null }>(dbPath, 'SELECT lease_owner FROM runs ORDER BY id').map((row) => row.lease_owner);

describe('runtime end to end over runtime.sock (system timers, in-process gateway)', () => {
  it('a session and run reach COMPLETED over runtime.sock with SSE', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession();
    const run = await launched.createRun(session.id, { input: 'Say hello' });
    const stream = await launched.stream(`/v1/runs/${run.id}/events`);
    const frames = await stream.toEnd(30_000);
    expect(frames.at(-1)).toMatchObject({ type: 'run.status', to: 'COMPLETED' });
    expect(frames.filter((event) => event.type === 'agent.message.delta').map((event) => event.text).join('')).toBe(FAKE_DETERMINISTIC_REPLY);
    expect((await launched.http('GET', `/v1/runs/${run.id}`)).json.run).toMatchObject({ status: 'COMPLETED' });
    expect(stack.completions()).toBe(1);
  });

  it('the lease owner is runtime-<pid>-<startedAtMs>-0', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp);
    const startedAtMs = Date.parse(launched.handle.ready.startedAt);
    const hold = stack.hold();
    const session = await launched.createSession();
    await launched.createRun(session.id);
    await hold.waitForRequest();
    expect(leaseOwners(stack.temp.paths.databases.runtime)).toEqual([`runtime-${process.pid}-${startedAtMs}-0`]);
    hold.release();
  });

  it('workerCount 2 gives worker ids ending in -0 and -1', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchRuntime(stack.temp, { workerCount: 2 });
    const holds = [stack.hold(), stack.hold()];
    const startedAtMs = Date.parse(launched.handle.ready.startedAt);
    const first = await launched.createSession();
    const second = await launched.createSession();
    await launched.createRun(first.id);
    await launched.createRun(second.id);
    await Promise.all(holds.map((hold) => hold.waitForRequest()));
    expect([...leaseOwners(stack.temp.paths.databases.runtime)].sort()).toEqual([`runtime-${process.pid}-${startedAtMs}-0`, `runtime-${process.pid}-${startedAtMs}-1`]);
    for (const hold of holds) hold.release();
  });

  it('no trace body is stored, and the runtime telemetry service.name is momonga-runtime', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const namesBefore = control.serviceNames.length;
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession();
    const run = await launched.createRun(session.id);
    const stream = await launched.stream(`/v1/runs/${run.id}/events`);
    expect((await stream.toEnd(30_000)).at(-1)).toMatchObject({ type: 'run.status', to: 'COMPLETED' });
    const result = await launched.handle.close();
    expect(result).toEqual({ clean: true, abandoned: [], stragglers: [] });
    expect(control.serviceNames.slice(namesBefore)).toEqual(['momonga-runtime']);
    const traces = stack.temp.paths.traces.runtime;
    expect(readDb<{ count: number }>(traces, 'SELECT COUNT(*) AS count FROM spans WHERE run_id = ?', run.id)[0]?.count).toBeGreaterThan(0);
    expect(readDb<{ count: number }>(traces, 'SELECT COUNT(*) AS count FROM bodies')[0]?.count).toBe(0);
  });
});
