import { describe, expect, it } from 'vitest';
import { callStopOf } from '@momonga/tools';
import type { ToolContext, ToolStop } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';

const waitForAbort = (ctx: ToolContext): Promise<{ status: 'failed'; output: string }> =>
  new Promise((resolve) => {
    ctx.signal.addEventListener('abort', () => resolve({ status: 'failed', output: 'aborted by signal' }), { once: true });
  });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const outputOf = (outcome: unknown): string => {
  const value = outcome as { kind?: string; result?: { output?: string } };
  if (value.kind !== 'result' || typeof value.result?.output !== 'string') throw new Error('expected a result outcome');
  return value.result.output;
};

const stopTextOf = (stops: ToolStop[]) => async (stop: ToolStop): Promise<string> => {
  stops.push(stop);
  return `stopped by ${stop.bound} after ${stop.ms} ms`;
};

describe('G2: a call bounded by an idle window that progress restarts, an overall limit and the run deadline (audit-unbounded-waits-2026-11-07.md, R-G2a)', () => {
  it('test 9: reportProgress restarts the idle window, so a call that keeps reporting outlives one window', async () => {
    const harness = makeHarness();
    const stops: ToolStop[] = [];
    const tool = makeTool('Probe', {
      timeoutMs: 5_000,
      idleTimeoutMs: 120,
      stopText: stopTextOf(stops),
      execute: async (_input, ctx) => {
        for (let index = 0; index < 6; index += 1) {
          await sleep(60);
          ctx.reportProgress();
        }
        return { status: 'completed', output: 'finished after progress' };
      },
    });
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Probe')]));
    expect(outputOf(outcomes[0])).toBe('finished after progress');
    expect(stops).toEqual([]);
  });

  it('ends a call that stops reporting at the idle window, with the stop text of the tool', async () => {
    const harness = makeHarness();
    const stops: ToolStop[] = [];
    const tool = makeTool('Probe', {
      timeoutMs: 5_000,
      idleTimeoutMs: 100,
      stopText: stopTextOf(stops),
      execute: async (_input, ctx) => {
        await sleep(50);
        ctx.reportProgress();
        return waitForAbort(ctx);
      },
    });
    const startedAt = Date.now();
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Probe')]));
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
    expect(outputOf(outcomes[0])).toBe('stopped by idle after 100 ms');
    expect(stops).toMatchObject([{ bound: 'idle', ms: 100 }]);
  });

  it('test 9: progress never extends a call past its overall limit', async () => {
    const harness = makeHarness();
    const stops: ToolStop[] = [];
    const tool = makeTool('Probe', {
      timeoutMs: 200,
      idleTimeoutMs: 100,
      stopText: stopTextOf(stops),
      execute: async (_input, ctx) => {
        for (;;) {
          await sleep(30);
          if (ctx.signal.aborted) return { status: 'failed', output: 'aborted' };
          ctx.reportProgress();
        }
      },
    });
    const startedAt = Date.now();
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Probe')]));
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(outputOf(outcomes[0])).toBe('stopped by total after 200 ms');
  });

  it('test 6: the run deadline ends the call when it comes before both bounds, with the stop text of the tool', async () => {
    const harness = makeHarness();
    const stops: ToolStop[] = [];
    const tool = makeTool('Probe', {
      timeoutMs: 5_000,
      idleTimeoutMs: 1_000,
      stopText: stopTextOf(stops),
      execute: (_input, ctx) => waitForAbort(ctx),
    });
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Probe')], { deadlineAt: harness.clock.now() + 80 }));
    expect(outputOf(outcomes[0])).toBe('stopped by deadline after 80 ms');
    expect(stops).toEqual([{ bound: 'deadline', ms: 80 }]);
  });

  it('uses the executor sentence for a run deadline stop only when the tool declares no stop text', async () => {
    const harness = makeHarness();
    const tool = makeTool('Probe', { timeoutMs: 5_000, idleTimeoutMs: 1_000, execute: (_input, ctx) => waitForAbort(ctx) });
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Probe')], { deadlineAt: harness.clock.now() + 80 }));
    expect(outputOf(outcomes[0])).toBe('Probe timed out after 80 ms');
  });

  it('keeps a tool without an idle window on its own timeout, unchanged', async () => {
    const harness = makeHarness();
    const tool = makeTool('Read', {
      timeoutMs: 40,
      execute: (_input, ctx) => {
        ctx.reportProgress();
        return waitForAbort(ctx);
      },
    });
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Read')]));
    expect(outputOf(outcomes[0])).toBe('Read timed out after 40 ms');
  });

  it('no longer offers extendToRunDeadline: progress replaces it', async () => {
    const harness = makeHarness();
    let offered: unknown;
    const tool = makeTool('Probe', {
      execute: async (_input, ctx) => {
        offered = (ctx as unknown as Record<string, unknown>)['extendToRunDeadline'];
        return { status: 'completed', output: 'ok' };
      },
    });
    await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Probe')]));
    expect(offered).toBeUndefined();
  });
});

describe('callStopOf: the one rule that places the end of a call', () => {
  it('is the earliest of the idle window from the last progress, the overall limit from the start, and the run deadline', () => {
    expect(callStopOf({ startedAt: 0, lastProgressAt: 0, idleMs: 300_000, totalMs: 100_800_000, deadlineAt: 21_600_000 })).toEqual({ at: 300_000, bound: 'idle' });
    expect(callStopOf({ startedAt: 0, lastProgressAt: 21_500_000, idleMs: 300_000, totalMs: 100_800_000, deadlineAt: 21_600_000 })).toEqual({ at: 21_600_000, bound: 'deadline' });
    expect(callStopOf({ startedAt: 0, lastProgressAt: 100_700_000, idleMs: 300_000, totalMs: 100_800_000, deadlineAt: 604_800_000 })).toEqual({ at: 100_800_000, bound: 'total' });
  });

  it('has no idle term when the tool declares no idle window', () => {
    expect(callStopOf({ startedAt: 10, lastProgressAt: 10, idleMs: undefined, totalMs: 60_000, deadlineAt: 1_000_000 })).toEqual({ at: 60_010, bound: 'total' });
  });

  it('names the tool bound, not the deadline, when they fall at the same moment', () => {
    expect(callStopOf({ startedAt: 0, lastProgressAt: 0, idleMs: 100, totalMs: 100, deadlineAt: 100 })).toEqual({ at: 100, bound: 'idle' });
    expect(callStopOf({ startedAt: 0, lastProgressAt: 0, idleMs: undefined, totalMs: 100, deadlineAt: 100 })).toEqual({ at: 100, bound: 'total' });
  });
});

describe('the idle window is armed only when callStopOf places the stop at the idle term', () => {
  const progressNearTheFixedTerm = (harness: ReturnType<typeof makeHarness>, afterMs: number) => async (_input: unknown, ctx: ToolContext) => {
    harness.clock.set(harness.clock.now() + afterMs);
    ctx.reportProgress();
    return waitForAbort(ctx);
  };

  it('does not arm the idle window when the overall limit comes before it, so the call ends by the overall limit', async () => {
    const harness = makeHarness();
    const stops: ToolStop[] = [];
    const tool = makeTool('Probe', { timeoutMs: 400, idleTimeoutMs: 100, stopText: stopTextOf(stops), execute: progressNearTheFixedTerm(harness, 350) });
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Probe')]));
    expect(outputOf(outcomes[0])).toBe('stopped by total after 400 ms');
    expect(stops).toEqual([{ bound: 'total', ms: 400 }]);
  });

  it('does not arm the idle window when the run deadline comes before it, so the call ends by the deadline, with the stop text of the tool', async () => {
    const harness = makeHarness();
    const stops: ToolStop[] = [];
    const tool = makeTool('Probe', { timeoutMs: 5_000, idleTimeoutMs: 100, stopText: stopTextOf(stops), execute: progressNearTheFixedTerm(harness, 350) });
    const outcomes = await harness.executor.runBatch(await harness.input(await toolSetOf(tool), [call('c1', 'Probe')], { deadlineAt: harness.clock.now() + 400 }));
    expect(outputOf(outcomes[0])).toBe('stopped by deadline after 400 ms');
    expect(stops).toEqual([{ bound: 'deadline', ms: 400 }]);
  });
});
