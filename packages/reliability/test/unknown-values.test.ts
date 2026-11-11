import { describe, expect, it } from 'vitest';
import { aggregate, buildReliabilityReport, explainOf, foldFacts, formatReliabilityReport, indicatorsOf } from '@momonga/reliability';
import type { RunFacts } from '@momonga/reliability';
import { T0, eventsOf, runInfo, started, terminal } from './streams.ts';

const counted = (runId: string): RunFacts => foldFacts(eventsOf(runId, [[T0, started(1)], [T0 + 1, terminal('COMPLETED')]]), runInfo({ runId }));

const recovered = (runId: string): RunFacts => ({
  ...counted(runId),
  recoveries: [{ ordinal: 1, cause: 'process_lost', failedAt: T0, progressAt: T0 + 1, outcome: 'recovered', startedSeq: 1, progressSeq: 2 }],
});

describe('run facts holding a value this build does not know (11.4)', () => {
  it.each([
    ['status', (row: RunFacts): RunFacts => ({ ...row, status: 'unknown' })],
    ['stop reason', (row: RunFacts): RunFacts => ({ ...row, status: 'STOPPED', stopReason: 'unknown' })],
    ['mode', (row: RunFacts): RunFacts => ({ ...row, mode: 'unknown' })],
    ['recovery outcome', (row: RunFacts): RunFacts => ({ ...row, recoveries: row.recoveries.map((episode) => ({ ...episode, outcome: 'unknown' })) })],
    ['recovery cause', (row: RunFacts): RunFacts => ({ ...row, recoveries: row.recoveries.map((episode) => ({ ...episode, cause: 'unknown' })) })],
  ] as const)('a root with an unknown %s is reported as unknown and counted in no known outcome', (_label, withUnknown) => {
    const rows = [counted('known'), withUnknown(recovered('strange'))];
    const aggregated = aggregate(rows, { groupBy: 'model' });
    const total = indicatorsOf(aggregated).total;
    expect(total.buckets).toEqual({ counted: 1, cancelled: 0, pendingFacts: 0, factsUnavailable: 0, unknownValues: 1, notPlaced: 0 });
    expect(total.recovery).toEqual({ k: 0, n: 0, unknownEffect: 0, failed: 0, stopped: 0 });
    expect(total.completion.n + total.completion.undeclared).toBe(1);
    expect(total.overrun.budgetStops).toBe(0);
    expect(explainOf(aggregated).get('unknown values')).toEqual(['strange']);
    expect(formatReliabilityReport(buildReliabilityReport({ kind: 'real', aggregate: aggregated }))).toContain('unknown values 1 (excluded)');
  });
});
