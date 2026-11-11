import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { aggregate, buildReliabilityReport, foldFacts, formatReliabilityReport, indicatorsOf } from '@momonga/reliability';
import type { RunFacts } from '@momonga/reliability';
import { T0, eventsOf, modelResponded, runInfo, started, terminal, toolCall, toolCompleted, toolStarted } from './streams.ts';
import type { Timed } from './streams.ts';

const verified = (round: number, outcome: 'passed' | 'failed', durationMs: number, mutationSeq: number): RunEventPayload => ({
  type: 'verification.completed',
  round,
  conditionId: 'tests',
  command: 'npm test',
  outcome,
  durationMs,
  output: outcome,
  mutationSeq,
});

const fold = (runId: string, timed: readonly Timed[]): RunFacts => foldFacts(eventsOf(runId, timed), runInfo({ runId }));

const passesFirst = fold('r1', [
  [T0, started(1, { declared: true })],
  [T0 + 100, toolCall('c1', 'write')],
  [T0 + 110, toolStarted('c1')],
  [T0 + 120, toolCompleted('c1')],
  [T0 + 400, verified(1, 'passed', 100, 4)],
  [T0 + 1000, terminal('COMPLETED')],
]);

const failsThenFixed = fold('r2', [
  [T0, started(1, { declared: true })],
  [T0 + 100, toolCall('c1', 'write')],
  [T0 + 110, toolStarted('c1')],
  [T0 + 120, toolCompleted('c1')],
  [T0 + 500, verified(1, 'failed', 300, 4)],
  [T0 + 600, modelResponded(2)],
  [T0 + 800, verified(2, 'passed', 100, 4)],
  [T0 + 1000, terminal('COMPLETED')],
]);

const undeclaredReadOnly = fold('r3', [
  [T0, started(1)],
  [T0 + 100, toolCall('c1', 'read_only')],
  [T0 + 110, toolStarted('c1')],
  [T0 + 120, toolCompleted('c1')],
  [T0 + 1000, terminal('COMPLETED')],
]);

const rows = [passesFirst, failsThenFixed, undeclaredReadOnly];

describe('the verification indicators of the reliability report (X8, M1, M4, M6)', () => {
  it('folds the rounds of a run from its verification events', () => {
    expect(passesFirst.verification).toEqual({ rounds: 1, firstRoundPassed: true, failedRounds: 0, checkMs: 100, fixRoundTokens: 0 });
    expect(failsThenFixed.verification).toEqual({ rounds: 2, firstRoundPassed: false, failedRounds: 1, checkMs: 400, fixRoundTokens: 2 });
    expect(undeclaredReadOnly.verification).toEqual({ rounds: 0, firstRoundPassed: null, failedRounds: 0, checkMs: 0, fixRoundTokens: 0 });
    expect(rows.map((row) => [row.mutated, row.owed])).toEqual([
      [true, true],
      [true, true],
      [false, false],
    ]);
  });

  it('counts the first-round passes, the runs with a failed round, the gate coverage and the cost of the checks', () => {
    const { total } = indicatorsOf(aggregate(rows, { groupBy: 'model' }));
    expect(total.verification).toEqual({ firstRoundPassed: { k: 1, n: 2 }, failedRound: { k: 1, n: 2 }, coverage: { k: 2, n: 2 }, checkMs: 500, elapsedMs: 2000, fixRoundTokens: 2 });
  });

  it('prints the X8 rate, the M4 count, the gate coverage and the cost of verification', () => {
    const text = formatReliabilityReport(buildReliabilityReport({ kind: 'real', aggregate: aggregate(rows, { groupBy: 'model' }) }));
    expect(text).toContain('Verification Success Rate (first round passed): 1/2');
    expect(text).toContain('Averted False Completion (runs with a failed round): 1/2');
    expect(text).toContain('Gate Coverage (runs with a mutation that owed a condition): 2/2');
    expect(text).toContain('Verification Effort: checks took 500 ms of 2000 ms elapsed in the runs with a round (25.0%); tokens of fix rounds 2');
  });
});
