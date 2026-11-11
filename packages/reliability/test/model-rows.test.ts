import { describe, expect, it } from 'vitest';
import { RELIABILITY_FORMAT } from '@momonga/protocol';
import { aggregate, buildReliabilityReport, decodeReliabilityReport, encodeReliabilityReport, foldFacts, indicatorsOf } from '@momonga/reliability';
import type { RunFacts } from '@momonga/reliability';
import { T0, eventsOf, runInfo, started, terminal } from './streams.ts';

const FIRST = 'ollama/devstral-small-2:latest';
const SECOND = 'lmstudio/gemma-3-4b';

const rowOf = (runId: string, model: string): RunFacts =>
  foldFacts(
    eventsOf(runId, [
      [T0, started(1, { model })],
      [T0 + 100, terminal('COMPLETED')],
    ]),
    runInfo({ runId, status: 'COMPLETED', model }),
  );

describe('the model of a reliability row', () => {
  it('is the field model of the row, and the grouping key model groups the rows by it', () => {
    const rows = [rowOf('r1', FIRST), rowOf('r2', FIRST), rowOf('r3', SECOND)];
    expect(rows.map((row) => row.model)).toEqual([FIRST, FIRST, SECOND]);
    for (const row of rows) expect(row).not.toHaveProperty('modelAlias');
    const { groups } = indicatorsOf(aggregate(rows, { groupBy: 'model' }));
    expect(Object.keys(groups).sort()).toEqual([SECOND, FIRST].sort());
    expect(groups[FIRST]?.buckets.counted).toBe(2);
    expect(groups[SECOND]?.buckets.counted).toBe(1);
  });

  it('is written as momonga-reliability/5, and a momonga-reliability/2 report is retired because its rows held an alias name', () => {
    expect(RELIABILITY_FORMAT).toBe('momonga-reliability/5');
    const current = JSON.parse(encodeReliabilityReport(buildReliabilityReport({ kind: 'real', aggregate: aggregate([], { groupBy: 'model' }) }))) as Record<string, unknown>;
    expect(current['format']).toBe('momonga-reliability/5');
    const old = JSON.stringify({ ...current, format: 'momonga-reliability/2' });
    expect(() => decodeReliabilityReport(old)).toThrow(
      'momonga-reliability/2 reports do not record the model of each run (it was recorded as an alias name), so momonga-reliability/2 is retired; rebuild the report as momonga-reliability/5',
    );
  });
});
