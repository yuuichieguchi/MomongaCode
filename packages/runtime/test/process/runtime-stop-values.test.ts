import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STOP_VALUES } from '@momonga/foundation';
import type { StopValues } from '@momonga/foundation';
import { RUNTIME_ENTRY_FLAGS } from '@momonga/runtime';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeTimers } from '@momonga/testkit';
import { START_MS } from './helpers.ts';
import { fireTimer, launchRuntime, startStack, stepsLogged, timerIds, waitForCondition, waitForStatus, waitForTimer } from './run-helpers.ts';

const control = vi.hoisted(() => ({
  closeAllGraces: [] as Array<number | undefined>,
  adminCloseGraces: [] as Array<number | undefined>,
  holdCloseAll: false,
  holdAdminClose: false,
  releaseCloseAll: () => undefined as void,
  releaseAdminClose: () => undefined as void,
}));

vi.mock('../../src/process/mcp-pool-cache.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/process/mcp-pool-cache.ts')>();
  return {
    ...original,
    createMcpPoolCache: (options: Parameters<typeof original.createMcpPoolCache>[0]) => {
      const cache = original.createMcpPoolCache(options);
      return {
        ...cache,
        closeAll: async (graceMs?: number) => {
          control.closeAllGraces.push(graceMs);
          if (control.holdCloseAll) await new Promise<void>((resolve) => (control.releaseCloseAll = resolve));
          await (cache.closeAll as (graceMs?: number) => Promise<void>)(graceMs);
        },
      };
    },
  };
});

vi.mock('../../src/process/mcp-admin.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/process/mcp-admin.ts')>();
  return {
    ...original,
    createMcpAdmin: (options: Parameters<typeof original.createMcpAdmin>[0]) => {
      const admin = original.createMcpAdmin(options);
      return {
        ...admin,
        close: async (graceMs?: number) => {
          control.adminCloseGraces.push(graceMs);
          if (control.holdAdminClose) await new Promise<void>((resolve) => (control.releaseAdminClose = resolve));
          await (admin.close as (graceMs?: number) => Promise<void>)(graceMs);
        },
      };
    },
  };
});

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });
const CLEAN = { clean: true, abandoned: [], stragglers: [] };
const VALUES: StopValues = { ...DEFAULT_STOP_VALUES, closeGraceMs: 300_000, managedServerStopGraceMs: 60_000, drainTimeoutMs: 4321, mcpCloseGraceMs: 50 };
const DERIVED_TEARDOWN_MS = 10_000 + 6 * 50 + 10_125;

beforeEach(() => {
  control.closeAllGraces = [];
  control.adminCloseGraces = [];
  control.holdCloseAll = false;
  control.holdAdminClose = false;
});

const launchFake = async (stack: Awaited<ReturnType<typeof startStack>>) => {
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const launched = await launchRuntime(stack.temp, { clock, fakeTimers: timers });
  return { ...launched, clock, timers };
};

const runningRequest = async (stack: Awaited<ReturnType<typeof startStack>>, launched: Awaited<ReturnType<typeof launchFake>>) => {
  const hold = stack.hold();
  const session = await launched.createSession();
  const run = (await launched.createRun(session.id)) as { id: string };
  await hold.waitForRequest();
  return { id: run.id, hold };
};

describe('the runtime drain is a stop value, not a spawn flag', () => {
  it('RUNTIME_ENTRY_FLAGS has no --drain-timeout-ms', () => {
    expect(Object.keys(RUNTIME_ENTRY_FLAGS)).not.toContain('drain-timeout-ms');
  });
});

describe('the runtime close takes the values its stop carries (fake timers, in-process gateway)', () => {
  it('arms the drain at the carried drainTimeoutMs, and the run it cut is QUEUED', async () => {
    const stack = await startStack();
    const launched = await launchFake(stack);
    const run = await runningRequest(stack, launched);
    const closing = launched.handle.close(VALUES);
    await fireTimer(launched.timers, 4321, 'the drain timer at the carried drain');
    expect(await closing).toEqual(CLEAN);
    expect(await waitForStatus(stack.temp, run.id, ['QUEUED', 'COMPLETED', 'FAILED'])).toBe('QUEUED');
    expect(launched.timers.pending()).toEqual([]);
  });

  it('at drain 0 the drain is decided by its timer at once and the runtime aborts its workers (R8)', async () => {
    const stack = await startStack();
    const launched = await launchFake(stack);
    const run = await runningRequest(stack, launched);
    const before = timerIds(launched.timers);
    const closing = launched.handle.close({ ...VALUES, drainTimeoutMs: 0 });
    await fireTimer(launched.timers, 1, 'the drain timer armed at drain 0 (a zero delay fires on the next tick)', before);
    expect(await closing).toEqual(CLEAN);
    expect(await waitForStatus(stack.temp, run.id, ['QUEUED', 'COMPLETED', 'FAILED'])).toBe('QUEUED');
  });

  it('runs the teardown under runtimeTeardownBudgetMs of the carried MCP grace', async () => {
    control.holdCloseAll = true;
    const stack = await startStack();
    const launched = await launchFake(stack);
    const closing = launched.handle.close(VALUES);
    await waitForCondition(() => stepsLogged(launched.logger, 'teardown.step').includes('mcp-pools'), 'the mcp-pools step');
    await waitForTimer(launched.timers, DERIVED_TEARDOWN_MS, 'the teardown budget at 10000 + 6g + 125 + 2K');
    launched.timers.advance(DERIVED_TEARDOWN_MS - 1);
    control.releaseCloseAll();
    expect(await closing).toEqual(CLEAN);
  });

  it('closes the session pools and the admin probe pools in parallel, each with the carried MCP grace', async () => {
    control.holdCloseAll = true;
    control.holdAdminClose = true;
    const stack = await startStack();
    const launched = await launchFake(stack);
    const closing = launched.handle.close(VALUES);
    await waitForCondition(() => control.closeAllGraces.length === 1 && control.adminCloseGraces.length === 1, 'both pool closes to begin while neither has finished');
    expect(control.closeAllGraces).toEqual([50]);
    expect(control.adminCloseGraces).toEqual([50]);
    control.releaseAdminClose();
    control.releaseCloseAll();
    expect(await closing).toEqual(CLEAN);
  });

  it('an abort carries the MCP grace to the pool closes as well', async () => {
    const stack = await startStack();
    const launched = await launchFake(stack);
    expect(await launched.handle.abort({ ...VALUES, mcpCloseGraceMs: 7 })).toEqual(CLEAN);
    expect(control.closeAllGraces).toEqual([7]);
    expect(control.adminCloseGraces).toEqual([7]);
  });
});
