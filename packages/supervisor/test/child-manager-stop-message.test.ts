import { describe, expect, it } from 'vitest';
import { KILL_CONFIRM_MS, formatStopMessage, managedServerReapBoundMs } from '@momonga/foundation';
import type { StopValues } from '@momonga/foundation';
import { afterMicrotasks } from '@momonga/testkit';
import type { FakeChild } from './support/p2-fake-spawn-port.ts';
import { createManagerHarness } from './support/p2-manager-harness.ts';
import type { ManagerHarness, ManagerHarnessOptions } from './support/p2-manager-harness.ts';

const VALUES: StopValues = { closeGraceMs: 1200, managedServerStopGraceMs: 300, drainTimeoutMs: 300_000, mcpCloseGraceMs: 30_000 };
const TERM_BUDGET_MS = 1200 + 4 * 300 + 10_075 + 5000;
const ABORT_BUDGET_MS = 4 * 300 + 10_075 + 5000;

type HeldWrite = { chunks: string[]; complete(error?: Error): void };

const holdLifelineWrites = (child: FakeChild): HeldWrite => {
  const chunks: string[] = [];
  const callbacks: Array<(error?: Error | null) => void> = [];
  child.lifeline.write = ((chunk: string, ...rest: unknown[]) => {
    chunks.push(String(chunk));
    const callback = rest.find((entry) => typeof entry === 'function') as ((error?: Error | null) => void) | undefined;
    if (callback !== undefined) callbacks.push(callback);
    return false;
  }) as typeof child.lifeline.write;
  return {
    chunks,
    complete: (error) => {
      for (const callback of callbacks.splice(0)) callback(error ?? null);
    },
  };
};

const gatewayHarness = (context: Parameters<typeof createManagerHarness>[0], options: ManagerHarnessOptions = {}): { harness: ManagerHarness; child: FakeChild; write: HeldWrite } => {
  const harness = createManagerHarness(context, { role: 'gateway', ...options });
  harness.spawnInitial();
  const child = harness.port.last();
  return { harness, child, write: holdLifelineWrites(child) };
};

describe('the gateway stop carries its values on the lifeline', () => {
  it('writes one stop line with the values and sends SIGTERM only when the write completes', async (context) => {
    const { harness, child, write } = gatewayHarness(context);
    void harness.manager.stop('shutdown', 'term', VALUES);
    await afterMicrotasks();
    expect(write.chunks).toEqual([formatStopMessage(VALUES)]);
    expect(child.signals).toEqual([]);
    write.complete();
    await afterMicrotasks();
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('arms the stop deadline when the stop begins, before the write: a write not done by the deadline forces the kill then, with no SIGTERM', async (context) => {
    const { harness, child } = gatewayHarness(context);
    void harness.manager.stop('shutdown', 'term', VALUES);
    await afterMicrotasks();
    harness.timers.advance(TERM_BUDGET_MS - 1);
    expect(child.groupKills).toBe(0);
    harness.timers.advance(1);
    expect(child.groupKills).toBe(1);
    expect(child.signals).toEqual([]);
  });

  it('counts the deadline from the begin of the stop, not from the late signal', async (context) => {
    const { harness, child, write } = gatewayHarness(context);
    void harness.manager.stop('shutdown', 'term', VALUES);
    await afterMicrotasks();
    harness.timers.advance(3000);
    write.complete();
    await afterMicrotasks();
    expect(child.signals).toEqual(['SIGTERM']);
    harness.timers.advance(TERM_BUDGET_MS - 3000 - 1);
    expect(child.groupKills).toBe(0);
    harness.timers.advance(1);
    expect(child.groupKills).toBe(1);
  });

  it('a failed write forces the kill at once, with no SIGTERM, confirmed within KILL_CONFIRM_MS', async (context) => {
    const { harness, child, write } = gatewayHarness(context);
    const stopped = harness.manager.stop('shutdown', 'term', VALUES);
    await afterMicrotasks();
    write.complete(new Error('EPIPE'));
    await afterMicrotasks();
    expect(child.signals).toEqual([]);
    expect(child.groupKills).toBe(1);
    harness.timers.advance(KILL_CONFIRM_MS - 1);
    expect(harness.manager.state()).toBe('stopping');
    harness.timers.advance(1);
    await expect(stopped).resolves.toEqual({ killed: true, leaked: true });
  });

  it('bounds an aborting gateway by gatewayAbortBudgetMs of its values, not the fixed 10000', async (context) => {
    const { harness, child, write } = gatewayHarness(context);
    void harness.manager.stop('shutdown', 'int', VALUES);
    await afterMicrotasks();
    write.complete();
    await afterMicrotasks();
    expect(child.signals).toEqual(['SIGINT']);
    harness.timers.advance(ABORT_BUDGET_MS - 1);
    expect(child.groupKills).toBe(0);
    harness.timers.advance(1);
    expect(child.groupKills).toBe(1);
  });

  it('re-arms the budget at min(abort budget, time left) when a term stop switches to int', async (context) => {
    const early = gatewayHarness(context);
    void early.harness.manager.stop('shutdown', 'term', VALUES);
    await afterMicrotasks();
    early.write.complete();
    await afterMicrotasks();
    early.harness.timers.advance(500);
    void early.harness.manager.stop('shutdown', 'int', VALUES);
    early.harness.timers.advance(ABORT_BUDGET_MS - 1);
    expect(early.child.groupKills).toBe(0);
    early.harness.timers.advance(1);
    expect(early.child.groupKills).toBe(1);

    const late = gatewayHarness(context);
    void late.harness.manager.stop('shutdown', 'term', VALUES);
    await afterMicrotasks();
    late.write.complete();
    await afterMicrotasks();
    late.harness.timers.advance(TERM_BUDGET_MS - 1000);
    void late.harness.manager.stop('shutdown', 'int', VALUES);
    late.harness.timers.advance(999);
    expect(late.child.groupKills).toBe(0);
    late.harness.timers.advance(1);
    expect(late.child.groupKills).toBe(1);
  });
});

type ReapDirectoryCall = { dir: string; killGraceMs: number };

const reapingHarness = (context: Parameters<typeof createManagerHarness>[0]) => {
  const calls: ReapDirectoryCall[] = [];
  const signals: AbortSignal[] = [];
  const pending = Promise.withResolvers<{ reaped: number; kept: number }>();
  const setup = gatewayHarness(context, {
    overrides: {
      markerPorts: {
        reapMarkedProcesses: async () => ({ removed: true }),
        reapMarkerDirectory: async (options) => {
          calls.push({ dir: options.dir, killGraceMs: options.killGraceMs });
          signals.push(options.signal);
          return pending.promise;
        },
      },
    },
  });
  return { ...setup, calls, signals, finishReap: () => pending.resolve({ reaped: 1, kept: 0 }) };
};

const settledFlag = (promise: Promise<unknown>): { done: boolean } => {
  const flag = { done: false };
  void promise.then(() => {
    flag.done = true;
  });
  return flag;
};

describe('a gone gateway child has its managed servers reaped before it counts as stopped', () => {
  it.for([
    ['killed at its deadline with a managed server still running', 'deadline'],
    ['forced after a failed write', 'failed-write'],
    ['closed by itself', 'closed'],
    ['cut during an abort', 'abort'],
  ] as const)('when it was %s', async ([, path], testContext) => {
    const { harness, child, write, calls, finishReap } = reapingHarness(testContext);
    const mode = path === 'abort' ? 'int' : 'term';
    const stopped = harness.manager.stop('shutdown', mode, VALUES);
    const flag = settledFlag(stopped);
    await afterMicrotasks();
    if (path === 'failed-write') write.complete(new Error('EPIPE'));
    else write.complete();
    await afterMicrotasks();
    if (path === 'deadline') harness.timers.advance(TERM_BUDGET_MS);
    if (path === 'abort') harness.timers.advance(ABORT_BUDGET_MS);
    child.exit(path === 'closed' ? 0 : null, path === 'closed' ? null : 'SIGKILL');
    await afterMicrotasks();
    harness.timers.advance(KILL_CONFIRM_MS);
    await afterMicrotasks();
    expect(calls).toEqual([{ dir: harness.paths.markers.targets, killGraceMs: VALUES.managedServerStopGraceMs }]);
    expect(flag.done).toBe(false);
    expect(harness.manager.state()).toBe('stopping');
    finishReap();
    await stopped;
    expect(harness.manager.state()).toBe('stopped');
  });
});

describe('the reap of the managed servers of a gone gateway child is bounded by the term the stop formula reserves for it', () => {
  it('passes a signal that aborts when the managed server reap bound has passed', async (testContext) => {
    const { harness, child, write, signals, finishReap } = reapingHarness(testContext);
    const stopped = harness.manager.stop('shutdown', 'term', VALUES);
    await afterMicrotasks();
    write.complete();
    await afterMicrotasks();
    child.exit(0, null);
    await afterMicrotasks();
    expect(signals).toHaveLength(1);
    const [signal] = signals;
    expect(signal?.aborted).toBe(false);
    harness.timers.advance(managedServerReapBoundMs(VALUES) - 1);
    expect(signal?.aborted).toBe(false);
    harness.timers.advance(1);
    expect(signal?.aborted).toBe(true);
    finishReap();
    await stopped;
  });
});
