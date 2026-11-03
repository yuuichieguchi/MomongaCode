import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpPool, McpPoolOptions } from '@momonga/mcp';
import type { GatewayClient, GatewayClientOptions, Worker, WorkerOptions } from '@momonga/runtime';
import { BUILT_BINARY_TEST_TIMEOUT_MS, MCP_MODERN_SERVER_PATH, createFakeClock, createFakeTimers, waitFor } from '@momonga/testkit';
import { START_MS, trackGroup } from './helpers.ts';
import {
  ABORT_BUDGET_MS,
  CANCEL_SETTLE_MS,
  TEARDOWN_BUDGET_MS,
  approveOnce,
  fireDuringTeardownStep,
  finishApprovingPrompts,
  fireTimer,
  entriesNamed,
  eventTypes,
  exportedValue,
  launchRuntime,
  recordPgid,
  scriptedToolCall,
  startStack,
  stepsLogged,
  timerIds,
  waitForTimer,
  waitForCondition,
  waitForStatus,
} from './run-helpers.ts';

const control = vi.hoisted(() => ({
  stuckAbort: false,
  inertWorkers: false,
  stuckPool: false,
  hangCancel: false,
  pools: [] as { closes: number }[],
  cancels: [] as string[],
}));

vi.mock('@momonga/mcp', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/mcp')>();
  return {
    ...original,
    createMcpPool: (options: McpPoolOptions): McpPool => {
      if (!control.stuckPool) return original.createMcpPool(options);
      const record = { closes: 0 };
      control.pools.push(record);
      return {
        sources: [],
        diagnostics: () => [],
        close: () => {
          record.closes += 1;
          return new Promise<void>(() => undefined);
        },
      };
    },
  };
});

vi.mock('../../src/worker/worker.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/worker/worker.ts')>();
  return {
    ...original,
    createWorker: (options: WorkerOptions): Worker => {
      const worker = original.createWorker(options);
      if (control.inertWorkers) return { ...worker, start: () => undefined, stop: async () => undefined, abort: async () => undefined };
      if (!control.stuckAbort) return worker;
      return {
        ...worker,
        abort: (reason) => {
          void worker.abort(reason);
          return new Promise<void>(() => undefined);
        },
      };
    },
  };
});

vi.mock('../../src/gateway-client.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/gateway-client.ts')>();
  return {
    ...original,
    createGatewayClient: (options: GatewayClientOptions): GatewayClient => {
      const client = original.createGatewayClient(options);
      return new Proxy(client, {
        get: (target, key, receiver) => {
          if (key === 'cancel' && control.hangCancel) {
            return (idempotencyKey: string) => {
              control.cancels.push(idempotencyKey);
              return new Promise<boolean>(() => undefined);
            };
          }
          return Reflect.get(target, key, receiver);
        },
      });
    },
  };
});

const PROCESS_TIMEOUT = { timeout: BUILT_BINARY_TEST_TIMEOUT_MS };
const DRAIN_MS = 60_000;
const CLEAN = { clean: true, abandoned: [], stragglers: [] };

beforeEach(() => {
  control.stuckAbort = false;
  control.inertWorkers = false;
  control.stuckPool = false;
  control.hangCancel = false;
  control.pools = [];
  control.cancels = [];
});


const launchFake = async (stack: Awaited<ReturnType<typeof startStack>>, extra: { clock?: ReturnType<typeof createFakeClock> } = {}) => {
  const clock = extra.clock ?? createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const launched = await launchRuntime(stack.temp, { clock, fakeTimers: timers, drainTimeoutMs: DRAIN_MS });
  return { ...launched, clock, timers };
};

const runningRequest = async (stack: Awaited<ReturnType<typeof startStack>>, launched: Awaited<ReturnType<typeof launchFake>>) => {
  const hold = stack.hold();
  const session = await launched.createSession();
  const run = (await launched.createRun(session.id)) as { id: string };
  await hold.waitForRequest();
  return { id: run.id, hold };
};

describe('close and abort (manual fake timers for every runtime timer, in-process gateway)', () => {
  it('close waits for a claim to yield at the step boundary', PROCESS_TIMEOUT, async () => {
    const stack = await startStack((temp) => ({ script: [scriptedToolCall('Read', { file_path: path.join(temp.project, 'notes.txt') })] }));
    fs.writeFileSync(path.join(stack.temp.project, 'notes.txt'), 'remember this\n');
    const first = await launchFake(stack);
    const hold = stack.hold();
    const session = await first.createSession();
    const run = await first.createRun(session.id, { input: 'Read the notes' });
    await hold.waitForRequest();
    const closing = first.handle.close();
    await waitForTimer(first.timers, DRAIN_MS, 'the drain timer');
    hold.release();
    const result = await closing;
    expect(result).toEqual(CLEAN);
    expect(first.timers.pending()).toEqual([]);
    expect(await waitForStatus(stack.temp, run.id, ['QUEUED', 'COMPLETED', 'FAILED'])).toBe('QUEUED');
    expect(eventTypes(stack.temp, run.id)).not.toContain('tool.started');

    const second = await launchFake(stack, { clock: createFakeClock(START_MS + 60_000) });
    expect(await finishApprovingPrompts(second, stack.temp, run.id)).toBe('COMPLETED');
    expect(eventTypes(stack.temp, run.id)).toContain('tool.started');
    expect(stack.completions()).toBe(2);
    expect(await second.handle.close()).toEqual(CLEAN);
  });

  it('when drainTimeoutMs expires abort runs, the run is QUEUED and a restart completes it', PROCESS_TIMEOUT, async () => {
    const stack = await startStack({ script: [scriptedToolCall('Bash', { command: 'sleep 30' })] });
    const first = await launchFake(stack);
    const session = await first.createSession({ permissionMode: 'bypassPermissions', bypassAllowed: true });
    const run = await first.createRun(session.id, { input: 'Run the command' });
    expect(await waitForStatus(stack.temp, run.id, ['WAITING_HUMAN', 'COMPLETED', 'FAILED'])).toBe('WAITING_HUMAN');
    await approveOnce(first, run.id);
    await waitForCondition(() => recordPgid(stack.temp) !== undefined, 'the Bash process to attach');
    const pgid = recordPgid(stack.temp) as number;
    trackGroup(pgid);
    const closing = first.handle.close();
    await fireTimer(first.timers, DRAIN_MS, 'the drain timer');
    const result = await closing;
    expect(result).toEqual(CLEAN);
    expect(first.timers.pending()).toEqual([]);
    expect(await waitForStatus(stack.temp, run.id, ['QUEUED', 'COMPLETED', 'FAILED'])).toBe('QUEUED');

    const second = await launchFake(stack, { clock: createFakeClock(START_MS + 60_000) });
    expect(await finishApprovingPrompts(second, stack.temp, run.id)).toBe('COMPLETED');
    await second.handle.close();
  });

  it('abort during close resolves both with one teardown and the same result', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchFake(stack);
    await runningRequest(stack, launched);
    const closing = launched.handle.close();
    await waitForTimer(launched.timers, DRAIN_MS, 'the drain timer');
    const aborting = launched.handle.abort();
    expect(aborting).toBe(closing);
    const [closed, aborted] = await Promise.all([closing, aborting]);
    expect(closed).toBe(aborted);
    expect(closed).toEqual(CLEAN);
    expect(stepsLogged(launched.logger, 'teardown.step').filter((step) => step === 'timers')).toHaveLength(1);
    expect(launched.timers.pending()).toEqual([]);
  });

  it('close returns the same promise', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchFake(stack);
    const first = launched.handle.close();
    expect(launched.handle.close()).toBe(first);
    expect(launched.handle.abort()).toBe(first);
    expect(await first).toEqual(CLEAN);
  });

  it('a clean close resolves { clean: true, abandoned: [], stragglers: [] }', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchFake(stack);
    const result = await launched.handle.close();
    expect(result).toEqual(CLEAN);
    expect(result.fatal).toBeUndefined();
    expect(stepsLogged(launched.logger, 'teardown.step')).toEqual(['timers', 'workers', 'service', 'cancel-upstream', 'mcp-pools', 'background-jobs', 'gateway-client', 'telemetry', 'trace-store', 'store', 'lock']);
    expect(launched.timers.pending()).toEqual([]);
  });

  it('abort stragglers are logged with abort.stragglers (count and ids), listed with their worker ids in the result, and make clean false', PROCESS_TIMEOUT, async () => {
    control.stuckAbort = true;
    const stack = await startStack();
    const launched = await launchFake(stack);
    await runningRequest(stack, launched);
    const workerId = `runtime-${process.pid}-${START_MS}-0`;
    const before = timerIds(launched.timers);
    const aborting = launched.handle.abort();
    await fireTimer(launched.timers, ABORT_BUDGET_MS, 'the abort budget timer', before);
    const result = await aborting;
    expect(result).toEqual({ clean: false, abandoned: [], stragglers: [workerId] });
    const logged = entriesNamed(launched.logger, 'abort.stragglers');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: 'warn', fields: { count: 1, ids: [workerId] } });
    expect(launched.timers.pending()).toEqual([]);
  });

  it('a stuck MCP server makes teardown log teardown.abandoned, list the step in result.abandoned, set clean false and close within runtimeMaxCloseMs', PROCESS_TIMEOUT, async () => {
    control.stuckPool = true;
    const stack = await startStack({}, { mcpServers: { fx: { command: process.execPath, args: [MCP_MODERN_SERVER_PATH] } } });
    const launched = await launchFake(stack);
    const session = await launched.createSession();
    const run = await launched.createRun(session.id);
    expect(await waitForStatus(stack.temp, run.id, ['COMPLETED', 'FAILED', 'CANCELLED'])).toBe('COMPLETED');
    expect(control.pools).toHaveLength(1);
    const startedAt = launched.clock.now();
    const closing = launched.handle.close();
    await fireDuringTeardownStep(launched.logger, launched.timers, 'mcp-pools', TEARDOWN_BUDGET_MS);
    const result = await closing;
    expect(result).toEqual({ clean: false, abandoned: ['mcp-pools'], stragglers: [] });
    expect(control.pools[0]?.closes).toBe(1);
    expect(entriesNamed(launched.logger, 'teardown.abandoned')).toEqual([expect.objectContaining({ level: 'warn', fields: expect.objectContaining({ step: 'mcp-pools' }) })]);
    expect(stepsLogged(launched.logger, 'teardown.step').slice(-5)).toEqual(['gateway-client', 'telemetry', 'trace-store', 'store', 'lock']);
    const maxCloseMs = exportedValue<(drainTimeoutMs: number) => number>('runtimeMaxCloseMs')(DRAIN_MS);
    expect(launched.clock.now() - startedAt).toBeLessThanOrEqual(maxCloseMs);
    expect(launched.timers.pending()).toEqual([]);
  });

  it('the drain race, the abort race and every teardown step race clear their timers: fakeTimers.pending() is empty after close resolves', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchFake(stack);
    const run = await runningRequest(stack, launched);
    const closing = launched.handle.close();
    await fireTimer(launched.timers, DRAIN_MS, 'the drain timer');
    const result = await closing;
    expect(result).toEqual(CLEAN);
    expect(launched.timers.pending()).toEqual([]);
    expect(await waitForStatus(stack.temp, run.id, ['QUEUED', 'COMPLETED', 'FAILED'])).toBe('QUEUED');
  });

  it('a run created just before draining stays QUEUED for the next start', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const launched = await launchFake(stack);
    await runningRequest(stack, launched);
    const session = await launched.createSession();
    const late = (await launched.createRun(session.id)) as { id: string };
    const closing = launched.handle.close();
    await fireTimer(launched.timers, DRAIN_MS, 'the drain timer');
    expect(await closing).toEqual(CLEAN);
    expect(await waitForStatus(stack.temp, late.id, ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'])).toBe('QUEUED');
    expect(eventTypes(stack.temp, late.id).filter((type) => type.startsWith('model.'))).toEqual([]);
  });

  it('a gateway cancel that never answers does not hold teardown past the cancel-upstream step, and pending() is empty afterwards', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const first = await launchFake(stack);
    const run = await runningRequest(stack, first);
    expect(await first.handle.abort()).toEqual(CLEAN);
    expect(await waitForStatus(stack.temp, run.id, ['QUEUED', 'COMPLETED', 'FAILED'])).toBe('QUEUED');
    expect(eventTypes(stack.temp, run.id)).toContain('model.requested');
    expect(eventTypes(stack.temp, run.id)).not.toContain('model.responded');

    control.inertWorkers = true;
    control.hangCancel = true;
    const second = await launchFake(stack, { clock: createFakeClock(START_MS + 60_000) });
    expect((await second.http('POST', `/v1/runs/${run.id}/cancel`)).status).toBeLessThan(300);
    await waitFor(() => control.cancels.length === 1, { description: 'the upstream cancel' });
    expect(await waitForStatus(stack.temp, run.id, ['CANCELLED', 'CANCELLING'])).toBe('CANCELLED');
    const closing = second.handle.close();
    await fireDuringTeardownStep(second.logger, second.timers, 'cancel-upstream', CANCEL_SETTLE_MS);
    const result = await closing;
    expect(result).toEqual(CLEAN);
    expect(stepsLogged(second.logger, 'teardown.step')).toEqual(['timers', 'workers', 'service', 'cancel-upstream', 'mcp-pools', 'background-jobs', 'gateway-client', 'telemetry', 'trace-store', 'store', 'lock']);
    expect(second.timers.pending()).toEqual([]);
  });
});
