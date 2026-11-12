import { describe, expect, it } from 'vitest';
import { KILL_CONFIRM_MS, RUNTIME_ABORT_BUDGET_MS, formatStopMessage } from '@momonga/foundation';
import type { StopValues } from '@momonga/foundation';
import { afterMicrotasks } from '@momonga/testkit';
import { stopBudgetMs } from '../src/child-manager.ts';
import type { FakeChild } from './support/p2-fake-spawn-port.ts';
import { createManagerHarness } from './support/p2-manager-harness.ts';
import type { ManagerHarness } from './support/p2-manager-harness.ts';

const VALUES: StopValues = { closeGraceMs: 1200, managedServerStopGraceMs: 300, drainTimeoutMs: 4000, mcpCloseGraceMs: 50 };
const TEARDOWN_MS = 10_000 + 6 * 50 + 10_125;
const DERIVED_ABORT_BUDGET_MS = 2000 + 1000 + 5000 + 2 * 25;
const RUNTIME_TERM_BUDGET_MS = 4000 + DERIVED_ABORT_BUDGET_MS + TEARDOWN_MS + 5000;
const RUNTIME_SIGINT_BUDGET_MS = DERIVED_ABORT_BUDGET_MS + TEARDOWN_MS + 5000;

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

const runtimeHarness = async (context: Parameters<typeof createManagerHarness>[0]): Promise<{ harness: ManagerHarness; child: FakeChild; write: HeldWrite }> => {
  const harness = createManagerHarness(context, { role: 'runtime' });
  await harness.spawnInitial();
  const child = harness.port.last();
  return { harness, child, write: holdLifelineWrites(child) };
};

describe('the stop budget of each child is derived from the four values of its stop', () => {
  it('a runtime under term has runtimeStopBudgetMs of the values: drain + abort + derived teardown + margin', () => {
    expect(stopBudgetMs('runtime', 'term', VALUES)).toBe(RUNTIME_TERM_BUDGET_MS);
    expect(stopBudgetMs('runtime', 'term', { ...VALUES, drainTimeoutMs: 0, mcpCloseGraceMs: 0 })).toBe(8050 + 20_125 + 5000);
  });

  it('a runtime under int has the derived abort budget 8050 plus the derived teardown plus the margin, with no drain (design 2.6)', () => {
    expect(RUNTIME_ABORT_BUDGET_MS).toBe(DERIVED_ABORT_BUDGET_MS);
    expect(stopBudgetMs('runtime', 'int', VALUES)).toBe(RUNTIME_SIGINT_BUDGET_MS);
    expect(stopBudgetMs('runtime', 'int', { ...VALUES, drainTimeoutMs: 300_000, mcpCloseGraceMs: 30_000 })).toBe(8050 + 200_125 + 5000);
  });

  it('a gateway budget ignores the runtime values', () => {
    expect(stopBudgetMs('gateway', 'term', VALUES)).toBe(1200 + 4 * 300 + 10_075 + 5000);
    expect(stopBudgetMs('gateway', 'term', { ...VALUES, drainTimeoutMs: 300_000, mcpCloseGraceMs: 30_000 })).toBe(1200 + 4 * 300 + 10_075 + 5000);
  });
});

describe('the runtime stop carries its values on the lifeline', () => {
  it('writes one stop line with the four values and sends SIGTERM only when the write completes', async (context) => {
    const { harness, child, write } = await runtimeHarness(context);
    void harness.manager.stop('shutdown', 'term', VALUES);
    await afterMicrotasks();
    expect(write.chunks).toEqual([formatStopMessage(VALUES)]);
    expect(child.signals).toEqual([]);
    write.complete();
    await afterMicrotasks();
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('arms the runtime deadline at runtimeStopBudgetMs of the values when the stop begins: a write not done by then forces the kill with no SIGTERM', async (context) => {
    const { harness, child } = await runtimeHarness(context);
    void harness.manager.stop('shutdown', 'term', VALUES);
    await afterMicrotasks();
    harness.timers.advance(RUNTIME_TERM_BUDGET_MS - 1);
    expect(child.groupKills).toBe(0);
    harness.timers.advance(1);
    expect(child.groupKills).toBe(1);
    expect(child.signals).toEqual([]);
  });

  it('a signalled runtime is killed at runtimeStopBudgetMs of its values, counted from the begin of the stop', async (context) => {
    const { harness, child, write } = await runtimeHarness(context);
    void harness.manager.stop('shutdown', 'term', VALUES);
    await afterMicrotasks();
    harness.timers.advance(2000);
    write.complete();
    await afterMicrotasks();
    expect(child.signals).toEqual(['SIGTERM']);
    harness.timers.advance(RUNTIME_TERM_BUDGET_MS - 2000 - 1);
    expect(child.groupKills).toBe(0);
    harness.timers.advance(1);
    expect(child.groupKills).toBe(1);
  });

  it('a failed write forces the kill at once, with no SIGTERM, confirmed within KILL_CONFIRM_MS', async (context) => {
    const { harness, child, write } = await runtimeHarness(context);
    const stopped = harness.manager.stop('shutdown', 'term', VALUES);
    await afterMicrotasks();
    write.complete(new Error('EPIPE'));
    await afterMicrotasks();
    expect(child.signals).toEqual([]);
    expect(child.groupKills).toBe(1);
    harness.timers.advance(KILL_CONFIRM_MS);
    await expect(stopped).resolves.toEqual({ killed: true, leaked: true });
  });

  it('an aborting runtime gets the line, then SIGINT, and is killed at the derived abort budget', async (context) => {
    const { harness, child, write } = await runtimeHarness(context);
    void harness.manager.stop('shutdown', 'int', VALUES);
    await afterMicrotasks();
    expect(write.chunks).toEqual([formatStopMessage(VALUES)]);
    write.complete();
    await afterMicrotasks();
    expect(child.signals).toEqual(['SIGINT']);
    harness.timers.advance(RUNTIME_SIGINT_BUDGET_MS - 1);
    expect(child.groupKills).toBe(0);
    harness.timers.advance(1);
    expect(child.groupKills).toBe(1);
  });
});
