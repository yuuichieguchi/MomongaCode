import { describe, expect, it } from 'vitest';
import { bindingRuleIds, compactionFactsOf, governanceOf, lossSignalsOf, recalledOf, retrievalOf } from '@momonga/eval';
import type { ContextRule } from '@momonga/eval';
import { bash, compacted, denied, fidelity, governing, historyRead, memories, read } from './context-fixtures.ts';
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

  it('reads R from the last event, the set in effect at the end of the run', () => {
    expect(governanceOf(depthOne, publicEventsOf([governing('g1'), governing('g2')]))).toEqual({ fidelity: 1, consistency: 1, minimality: 1 });
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
  it('measures seq overlap between HistoryRead ranges and the gold ranges', () => {
    const events = publicEventsOf(historyRead('c1', 7, 10));
    expect(retrievalOf([{ seqFrom: 5, seqTo: 8 }], events)).toEqual({ relevant: 2, retrieved: 4, gold: 4 });
  });

  it('counts a seq once when ranges overlap', () => {
    const events = publicEventsOf([...historyRead('c1', 1, 3), ...historyRead('c2', 2, 4)]);
    expect(retrievalOf([{ seqFrom: 3, seqTo: 3 }, { seqFrom: 3, seqTo: 6 }], events)).toEqual({ relevant: 2, retrieved: 4, gold: 4 });
  });

  it('reports nothing retrieved when no range was read', () => {
    expect(retrievalOf([{ seqFrom: 1, seqTo: 2 }], [])).toEqual({ relevant: 0, retrieved: 0, gold: 2 });
  });
});

describe('compactionFactsOf', () => {
  it('counts only model summaries for fabrication and leaves unlabelled ones out', () => {
    const events = publicEventsOf([
      compacted(1, 'model', fidelity(['ghost.ts'], 4, 3)),
      compacted(2, 'model', fidelity([], 2, 2)),
      compacted(3, 'deterministic', fidelity(['x'], 8, 0)),
      compacted(4),
    ]);
    expect(compactionFactsOf(events)).toEqual({ compactions: 4, modelSummaries: 2, fabricatedSummaries: 1, identifiers: 6, retained: 5, unclassified: 1 });
  });
});

describe('lossSignalsOf', () => {
  it('finds each of the four signals after a compaction at seq 6', () => {
    const events = publicEventsOf([
      ...read('r1', '/p/a.ts', 'same'),
      ...bash('b1', 'npm test', 'failed'),
      ...denied('d1', 'rm -rf x'),
      compacted(6, 'model'),
      ...historyRead('h2', 2, 4),
      ...read('r2', '/p/a.ts', 'same'),
      ...bash('b2', 'npm test', 'failed'),
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
    const events = publicEventsOf([...read('r1', '/p/a.ts', 'same'), ...read('r2', '/p/a.ts', 'same'), ...bash('b1', 'npm test', 'failed'), ...bash('b2', 'npm test', 'failed')]);
    expect(lossSignalsOf(events)).toEqual([]);
  });

  it('does not call a reread of changed content a rediscovery', () => {
    const events = publicEventsOf([...read('r1', '/p/a.ts', 'old'), compacted(2, 'model'), ...read('r2', '/p/a.ts', 'new')]);
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
    const events = publicEventsOf([...bash('b1', 'npm test', 'failed'), compacted(2, 'model'), ...bash('b2', 'npm test', 'completed'), ...bash('b3', 'npm run lint', 'failed')]);
    expect(lossSignalsOf(events)).toEqual([]);
  });

  it('does not treat an ordinary failure as drift from a denial', () => {
    const events = publicEventsOf([...denied('d1', 'rm -rf x'), compacted(2, 'model'), ...bash('b1', 'rm -rf y', 'failed')]);
    expect(lossSignalsOf(events)).toEqual([]);
  });
});
