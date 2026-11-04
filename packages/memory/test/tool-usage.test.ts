import { describe, expect, it } from 'vitest';
import { CONTRIBUTION_WINDOW_RUNS, TOOL_USAGE_WINDOW_RUNS, deferredSetOf } from '@momonga/memory';
import type { ToolUsageRun } from '@momonga/memory';

const quiet = (offered: readonly string[]): ToolUsageRun => ({ offered, called: [] });
const repeat = (count: number, run: ToolUsageRun): ToolUsageRun[] => Array.from({ length: count }, () => run);

describe('the tool usage window size', () => {
  it('is twenty runs, the size of the contribution window', () => {
    expect(TOOL_USAGE_WINDOW_RUNS).toBe(20);
    expect(TOOL_USAGE_WINDOW_RUNS).toBe(CONTRIBUTION_WINDOW_RUNS);
  });
});

describe('deferredSetOf', () => {
  it('defers nothing while the window holds fewer runs than its size', () => {
    expect(deferredSetOf({ runs: repeat(19, quiet(['Glob', 'Grep'])) })).toEqual([]);
    expect(deferredSetOf({ runs: [] })).toEqual([]);
  });

  it('defers every tool that all twenty runs offered and none called, sorted by name', () => {
    expect(deferredSetOf({ runs: repeat(20, quiet(['Grep', 'Bash', 'Glob'])) })).toEqual(['Bash', 'Glob', 'Grep']);
  });

  it('keeps a tool that one run of the window called', () => {
    const runs = [...repeat(10, quiet(['Glob', 'Grep'])), { offered: ['Glob', 'Grep'], called: ['Grep'] }, ...repeat(9, quiet(['Glob', 'Grep']))];
    expect(deferredSetOf({ runs })).toEqual(['Glob']);
  });

  it('keeps a tool that one run of the window did not offer', () => {
    const runs = [...repeat(19, quiet(['Glob', 'Grep'])), quiet(['Glob'])];
    expect(deferredSetOf({ runs })).toEqual(['Glob']);
  });

  it('reads only the newest window-size runs, newest first', () => {
    const older = { offered: ['Glob', 'Grep'], called: ['Grep'] };
    expect(deferredSetOf({ runs: [...repeat(20, quiet(['Glob', 'Grep'])), older] })).toEqual(['Glob', 'Grep']);
    expect(deferredSetOf({ runs: [older, ...repeat(20, quiet(['Glob', 'Grep']))] })).toEqual(['Glob']);
  });

  it('never defers a tool that no run offered', () => {
    expect(deferredSetOf({ runs: repeat(20, { offered: ['Glob'], called: ['Grep'] }) })).toEqual(['Glob']);
  });

  it('takes a smaller window when one is given', () => {
    expect(deferredSetOf({ runs: repeat(3, quiet(['Glob'])), windowRuns: 3 })).toEqual(['Glob']);
    expect(deferredSetOf({ runs: repeat(2, quiet(['Glob'])), windowRuns: 3 })).toEqual([]);
  });
});

describe('T5-3: loads and deferred-state changes over a sequence of runs', () => {
  const WINDOW = 3;
  const TOOL = 'Glob';

  type Outcome = { loads: number; changes: number; uses: number };

  const simulate = (uses: readonly boolean[]): Outcome => {
    const history: ToolUsageRun[] = [];
    let loads = 0;
    let changes = 0;
    let previous = false;
    for (const used of uses) {
      const deferred = deferredSetOf({ runs: history, windowRuns: WINDOW }).includes(TOOL);
      if (deferred !== previous) changes += 1;
      previous = deferred;
      if (deferred && used) loads += 1;
      history.unshift({ offered: [TOOL], called: used ? [TOOL] : [] });
    }
    return { loads, changes, uses: uses.filter(Boolean).length };
  };

  const sequences = function* (length: number): Generator<boolean[]> {
    for (let mask = 0; mask < 2 ** length; mask += 1) yield Array.from({ length }, (_unused, bit) => ((mask >> bit) & 1) === 1);
  };

  it('defers after a window of unused runs and stops deferring once the tool is used', () => {
    expect(simulate([false, false, false, true, false])).toEqual({ loads: 1, changes: 2, uses: 1 });
    expect(simulate([false, false, false, false])).toEqual({ loads: 0, changes: 1, uses: 0 });
    expect(simulate([true, true, true, true])).toEqual({ loads: 0, changes: 0, uses: 4 });
  });

  it('holds for every use pattern of every length up to ten runs with a window of three', () => {
    for (let runs = 1; runs <= 10; runs += 1) {
      for (const uses of sequences(runs)) {
        const outcome = simulate(uses);
        expect(outcome.loads, uses.join(',')).toBeLessThanOrEqual(Math.ceil(runs / (WINDOW + 1)));
        expect(outcome.changes, uses.join(',')).toBeLessThanOrEqual(2 * outcome.uses + 1);
      }
    }
  });
});
