import { describe, expect, it } from 'vitest';
import { bindingRuleIds, compactionFactsOf, governanceOf, lossSignalsOf, recalledOf, retrievalOf } from '@momonga/eval';
import type { ContextRule } from '@momonga/eval';
import { bash, compacted, denied, deniedHistoryRead, failedHistoryRead, fidelity, governing, historyRead, marked, memories, padding, ran, read, summarized } from './context-fixtures.ts';
import { publicEventsOf } from './fixtures.ts';

const rule = (id: string, overrides: Partial<ContextRule> = {}): ContextRule => ({
  id,
  kind: 'constraint',
  target: 'pandas',
  text: `rule ${id}`,
  inScope: true,
  live: true,
  supersedes: [],
  ...overrides,
});

const depthOne = [rule('g1'), rule('g2', { supersedes: ['g1'] })];
const depthTwo = [rule('g1'), rule('g2', { supersedes: ['g1'] }), rule('g3', { supersedes: ['g2'] })];

describe('bindingRuleIds', () => {
  it('keeps only live, in-scope, non-superseded rules', () => {
    const rules = [...depthOne, rule('other', { target: 'x', inScope: false }), rule('gone', { target: 'y', live: false })];
    expect(bindingRuleIds(rules)).toEqual(['g2']);
  });

  it('does not revive what a retired successor replaced', () => {
    expect(bindingRuleIds([rule('g1'), rule('g2', { supersedes: ['g1'], live: false })])).toEqual([]);
  });

  it('does not let an out-of-scope rule supersede one that is in force', () => {
    expect(bindingRuleIds([rule('a'), rule('b', { supersedes: ['a'], inScope: false })])).toEqual(['a']);
  });

  it('keeps both maxima of a true conflict', () => {
    expect(bindingRuleIds([rule('a'), rule('b')])).toEqual(['a', 'b']);
  });
});

describe('governanceOf, against the revision rows of paper 8', () => {
  it('scores a pinned block that keeps the stale fact: fidelity 1, consistency 0, minimality 1/2', () => {
    expect(governanceOf(depthOne, publicEventsOf([governing('g1', 'g2')]))).toEqual({ fidelity: 1, consistency: 0, minimality: 0.5 });
  });

  it('scores resolution that returns only the binding fact as 1 on all three at depth 1', () => {
    expect(governanceOf(depthOne, publicEventsOf([governing('g2')]))).toEqual({ fidelity: 1, consistency: 1, minimality: 1 });
  });

  it('scores resolution as 1 on all three at depth 2', () => {
    expect(governanceOf(depthTwo, publicEventsOf([governing('g3')]))).toEqual({ fidelity: 1, consistency: 1, minimality: 1 });
  });

  it('gives minimality 1/3 at depth 2 when the whole chain is returned', () => {
    const scored = governanceOf(depthTwo, publicEventsOf([governing('g1', 'g2', 'g3')]));
    expect(scored?.minimality).toBeCloseTo(1 / 3, 12);
    expect(scored?.consistency).toBe(0);
  });

  it('scores only the stale fact as 0 on all three', () => {
    expect(governanceOf(depthOne, publicEventsOf([governing('g1')]))).toEqual({ fidelity: 0, consistency: 0, minimality: 0 });
  });

  it('leaves minimality undefined when no governing fact was returned', () => {
    expect(governanceOf(depthOne, publicEventsOf([governing()]))).toEqual({ fidelity: 0, consistency: 0, minimality: undefined });
  });

  it('treats a run with no governing event as an empty R', () => {
    expect(governanceOf(depthOne, [])).toEqual({ fidelity: 0, consistency: 0, minimality: undefined });
  });

  it('counts partial presence in fidelity and breaks consistency', () => {
    const rules = [rule('a', { target: 'a' }), rule('b', { target: 'b' })];
    expect(governanceOf(rules, publicEventsOf([governing('a')]))).toEqual({ fidelity: 0.5, consistency: 0, minimality: 1 });
  });

  it('counts an out-of-scope rule as a loaded governing fact that is not binding', () => {
    const rules = [rule('a', { target: 'a' }), rule('b', { target: 'b', inScope: false })];
    expect(governanceOf(rules, publicEventsOf([governing('a', 'b')]))).toEqual({ fidelity: 1, consistency: 0, minimality: 0.5 });
  });

  it('ignores an active id the case does not define', () => {
    expect(governanceOf(depthOne, publicEventsOf([governing('g2', 'unrelated')]))).toEqual({ fidelity: 1, consistency: 1, minimality: 1 });
  });

  it('reads fidelity and minimality from the last load, the set in effect at the end of the run', () => {
    expect(governanceOf(depthOne, publicEventsOf([governing('g1'), governing('g2')]))).toEqual({ fidelity: 1, consistency: 0, minimality: 1 });
  });

  it('breaks consistency when any load of the run held a stale set, even one corrected later', () => {
    expect(governanceOf(depthOne, publicEventsOf([governing('g2'), governing('g1', 'g2'), governing('g2')]))?.consistency).toBe(0);
    expect(governanceOf(depthOne, publicEventsOf([governing('g2'), governing('g2')]))?.consistency).toBe(1);
  });

  it('measures a case whose rules are all retired: loading a stale one is consistency 0 and minimality 0', () => {
    const retired = [rule('g1'), rule('g2', { supersedes: ['g1'], live: false })];
    expect(bindingRuleIds(retired)).toEqual([]);
    expect(governanceOf(retired, publicEventsOf([governing('g1')]))).toEqual({ fidelity: undefined, consistency: 0, minimality: 0 });
    expect(governanceOf(retired, publicEventsOf([governing()]))).toEqual({ fidelity: undefined, consistency: 1, minimality: undefined });
  });

  it('is undefined for a case with no binding rule', () => {
    expect(governanceOf([], publicEventsOf([governing()]))).toBeUndefined();
  });
});

describe('recalledOf', () => {
  it('sums every load of the run', () => {
    expect(recalledOf(publicEventsOf([memories('stale', 'verified'), memories('stale', 'unbound', 'unverifiable')]))).toEqual({ stale: 2, recalled: 5 });
  });

  it('counts nothing without an event', () => {
    expect(recalledOf([])).toEqual({ stale: 0, recalled: 0 });
  });
});

describe('retrievalOf', () => {
  const early = [...read('r1', '/p/a.ts', 'one'), ...read('r2', '/p/b.ts', 'two'), ...padding(2)];
  const gold = [marked(early, 'r1'), marked(early, 'r2')];

  it('measures seq overlap between HistoryRead ranges and the gold ranges', () => {
    const events = publicEventsOf([...early, ...historyRead('c1', 3, 6)]);
    expect(retrievalOf(gold, events)).toEqual({ relevant: 2, retrieved: 4, gold: 4 });
  });

  it('counts a seq once when ranges overlap', () => {
    const events = publicEventsOf([...early, ...historyRead('c1', 1, 3), ...historyRead('c2', 2, 4)]);
    expect(retrievalOf([marked(early, 'r2'), marked(early, 'r2')], events)).toEqual({ relevant: 2, retrieved: 4, gold: 2 });
  });

  it('reports nothing retrieved when no range was read', () => {
    expect(retrievalOf(gold, [])).toEqual({ relevant: 0, retrieved: 0, gold: 4 });
  });

  it('counts only reads that delivered something: a denied or failed HistoryRead retrieved nothing', () => {
    expect(retrievalOf(gold, publicEventsOf([...early, ...deniedHistoryRead('c1', 1, 4)]))).toEqual({ relevant: 0, retrieved: 0, gold: 4 });
    expect(retrievalOf(gold, publicEventsOf([...early, ...failedHistoryRead('c1', 1, 4)]))).toEqual({ relevant: 0, retrieved: 0, gold: 4 });
  });

  it('does not count a call that has not completed', () => {
    const events = publicEventsOf(historyRead('c1', 1, 4).slice(0, 1));
    expect(retrievalOf(gold, events).retrieved).toBe(0);
  });

  it('cannot retrieve seqs that did not exist when the call was made', () => {
    const events = publicEventsOf([...early, ...historyRead('c1', 1, 100000)]);
    expect(retrievalOf(gold, events)).toEqual({ relevant: 4, retrieved: 7, gold: 4 });
  });
});

describe('compactionFactsOf', () => {
  it('counts every summary the model produced, accepted or rejected, and measures retention on accepted ones only', () => {
    const events = publicEventsOf([
      summarized(1, fidelity(['ghost.ts'], 4, 3)),
      summarized(2, fidelity([], 2, 2)),
      compacted(3, 'deterministic', fidelity([], 8, 0)),
      compacted(4),
    ]);
    expect(compactionFactsOf(events)).toEqual({ compactions: 4, modelSummaries: 3, fabricatedSummaries: 1, identifiers: 2, retained: 2, unclassified: 1 });
  });

  it('sees fabrication that the runtime records as a rejected summary with source deterministic', () => {
    const events = publicEventsOf([summarized(1, fidelity(['ghost.ts'], 4, 3))]);
    expect(compactionFactsOf(events)).toMatchObject({ modelSummaries: 1, fabricatedSummaries: 1, identifiers: 0, retained: 0 });
  });
});

describe('lossSignalsOf', () => {
  it('finds each of the four signals after a compaction at seq 6', () => {
    const events = publicEventsOf([
      ...ran(read('r1', '/p/a.ts', 'same')),
      ...ran(bash('b1', 'npm test', 'failed')),
      ...denied('d1', 'rm -rf x'),
      compacted(6, 'model'),
      ...historyRead('h2', 2, 4),
      ...ran(read('r2', '/p/a.ts', 'same')),
      ...ran(bash('b2', 'npm test', 'failed')),
      ...denied('d2', 'rm -rf x'),
    ]);
    expect(lossSignalsOf(events).map(({ kind, callId }) => [kind, callId])).toEqual([
      ['history_read', 'h2'],
      ['rediscovery', 'r2'],
      ['repeated_failure', 'b2'],
      ['instruction_drift', 'd2'],
    ]);
  });

  it('finds nothing in the same calls without a compaction', () => {
    const events = publicEventsOf([...ran(read('r1', '/p/a.ts', 'same')), ...ran(read('r2', '/p/a.ts', 'same')), ...ran(bash('b1', 'npm test', 'failed')), ...ran(bash('b2', 'npm test', 'failed'))]);
    expect(lossSignalsOf(events)).toEqual([]);
  });

  it('does not call a reread of changed content a rediscovery', () => {
    const events = publicEventsOf([...ran(read('r1', '/p/a.ts', 'old')), compacted(2, 'model'), ...ran(read('r2', '/p/a.ts', 'new'))]);
    expect(lossSignalsOf(events)).toEqual([]);
  });

  it('does not count a HistoryRead wholly above the compaction', () => {
    const events = publicEventsOf([...read('r1', '/p/a.ts', 'x'), compacted(2, 'model'), ...historyRead('h1', 4, 6)]);
    expect(lossSignalsOf(events)).toEqual([]);
  });

  it('counts a HistoryRead that reaches down to the compaction seq', () => {
    const events = publicEventsOf([...read('r1', '/p/a.ts', 'x'), compacted(2, 'model'), ...historyRead('h1', 3, 5)]);
    expect(lossSignalsOf(events).map((signal) => signal.kind)).toEqual(['history_read']);
  });

  it('does not count a command that succeeds after the compaction, nor one that failed only after it', () => {
    const events = publicEventsOf([...ran(bash('b1', 'npm test', 'failed')), compacted(2, 'model'), ...ran(bash('b2', 'npm test', 'completed')), ...ran(bash('b3', 'npm run lint', 'failed'))]);
    expect(lossSignalsOf(events)).toEqual([]);
  });

  it('does not treat an ordinary failure as drift from a denial', () => {
    const events = publicEventsOf([...denied('d1', 'rm -rf x'), compacted(2, 'model'), ...ran(bash('b1', 'rm -rf y', 'failed'))]);
    expect(lossSignalsOf(events)).toEqual([]);
  });
});
