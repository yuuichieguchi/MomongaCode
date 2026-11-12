import { describe, expect, it } from 'vitest';
import { compactionFactsOf } from '@momonga/eval';
import { fixtureCompactionItem } from '@momonga/testkit';
import { publicEventsOf } from './fixtures.ts';

describe('a compaction made by an earlier run of the session', () => {
  it('is counted by the run that inherits its summary, through the inherited compaction its journal records', () => {
    const events = publicEventsOf([
      { type: 'context.inherited_compacted', fromRunId: 'noise-run', item: fixtureCompactionItem('cmp-noise', 'summary'), summary: 'summary', replacedThroughSeq: 4 },
    ]);
    expect(compactionFactsOf(events)).toEqual({ compactions: 1, modelSummaries: 0, fabricatedSummaries: 0, identifiers: 0, retained: 0, unclassified: 0 });
  });
});
