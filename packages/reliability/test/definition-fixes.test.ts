import { describe, expect, it } from 'vitest';
import { aggregate, foldFacts, indicatorsOf } from '@momonga/reliability';
import type { RunFacts } from '@momonga/reliability';
import {
  T0,
  eventsOf,
  attemptLost,
  modelResponded,
  reconciled,
  runInfo,
  started,
  terminal,
  toolCall,
  toolCompleted,
  toolStarted,
} from './streams.ts';
import type { Timed } from './streams.ts';

const fold = (runId: string, timed: readonly Timed[]): RunFacts => foldFacts(eventsOf(runId, timed), runInfo({ runId }));

const totalOf = (rows: readonly RunFacts[]) => indicatorsOf(aggregate(rows, { groupBy: 'model' })).total;


describe('X2: a call open at the failure that is neither reconciled nor completed before progress makes the episode unknown_effect', () => {
  it('progress by a model response with the call still open is unknown_effect, not recovered', () => {
    const facts = fold('r1', [
      [T0, started(1)],
      [T0 + 1000, toolCall('c1', 'write')],
      [T0 + 1010, toolStarted('c1')],
      [T0 + 5000, attemptLost(T0 + 2000)],
      [T0 + 5010, started(2)],
      [T0 + 5200, modelResponded(2)],
      [T0 + 6000, terminal('COMPLETED')],
    ]);
    expect(facts.recoveries).toEqual([expect.objectContaining({ outcome: 'unknown_effect', progressAt: T0 + 5200 })]);
    const total = totalOf([facts]);
    expect(total.recovery).toEqual({ k: 0, n: 1, unknownEffect: 1, failed: 0, stopped: 0 });
    expect(total.recoveryTime).toEqual({ n: 0, meanMs: null, medianMs: null, clockSkew: 0 });
  });

  it('the open call started again before any reconcile is not progress; the completed end with the call unsettled is unknown_effect', () => {
    const facts = fold('r1', [
      [T0, started(1)],
      [T0 + 1000, toolCall('c1', 'write')],
      [T0 + 1010, toolStarted('c1')],
      [T0 + 5000, attemptLost(T0 + 2000)],
      [T0 + 5010, started(2)],
      [T0 + 5100, toolStarted('c1')],
      [T0 + 6000, terminal('COMPLETED')],
    ]);
    expect(facts.recoveries.map((episode) => episode.outcome)).toEqual(['unknown_effect']);
  });

  it('a completion of the open call is itself the progress and the episode is recovered at that instant', () => {
    const facts = fold('r1', [
      [T0, started(1)],
      [T0 + 1000, toolCall('c1', 'write')],
      [T0 + 1010, toolStarted('c1')],
      [T0 + 5000, attemptLost(T0 + 2000)],
      [T0 + 5010, started(2)],
      [T0 + 5100, toolCompleted('c1')],
      [T0 + 5200, modelResponded(2)],
      [T0 + 6000, terminal('COMPLETED')],
    ]);
    expect(facts.recoveries).toEqual([expect.objectContaining({ outcome: 'recovered', failedAt: T0 + 2000, progressAt: T0 + 5100 })]);
  });

  it('a call completed before the failure is not open: progress with nothing open is recovered', () => {
    const facts = fold('r1', [
      [T0, started(1)],
      [T0 + 1000, toolCall('c1', 'write')],
      [T0 + 1010, toolStarted('c1')],
      [T0 + 1020, toolCompleted('c1')],
      [T0 + 5000, attemptLost(T0 + 2000)],
      [T0 + 5010, started(2)],
      [T0 + 5200, modelResponded(2)],
      [T0 + 6000, terminal('COMPLETED')],
    ]);
    expect(facts.recoveries.map((episode) => episode.outcome)).toEqual(['recovered']);
  });

  it('a call reconciled in an earlier episode is not open again at the next failure', () => {
    const facts = fold('r1', [
      [T0, started(1)],
      [T0 + 1000, toolCall('c1', 'write')],
      [T0 + 1010, toolStarted('c1')],
      [T0 + 5000, attemptLost(T0 + 2000)],
      [T0 + 5010, started(2)],
      [T0 + 5100, reconciled('c1', 'already_applied')],
      [T0 + 5200, modelResponded(2)],
      [T0 + 8000, attemptLost(T0 + 7000)],
      [T0 + 8010, started(3)],
      [T0 + 8200, modelResponded(2)],
      [T0 + 9000, terminal('COMPLETED')],
    ]);
    expect(facts.recoveries.map((episode) => episode.outcome)).toEqual(['recovered', 'recovered']);
  });
});

describe('X3: the numerator counts only repeated starts of side-effecting calls, the population of its denominator', () => {
  it('a repeated start of a read_only call is in neither the numerator nor the denominator', () => {
    const facts = fold('r1', [
      [T0, started(1)],
      [T0 + 10, toolCall('c1', 'read_only')],
      [T0 + 20, toolStarted('c1')],
      [T0 + 30, toolStarted('c1')],
      [T0 + 40, toolCompleted('c1')],
      [T0 + 50, terminal('COMPLETED')],
    ]);
    expect(facts).toMatchObject({ repeatedStarts: 0, sideEffectingCalls: 0 });
    expect(totalOf([facts]).duplicates.journal).toEqual({ k: 0, n: 0 });
  });

  it('a task with a side-effecting call and a repeated read_only start has the repeat out of the numerator', () => {
    const facts = fold('r1', [
      [T0, started(1)],
      [T0 + 10, toolCall('w1', 'write')],
      [T0 + 20, toolStarted('w1')],
      [T0 + 30, toolCompleted('w1')],
      [T0 + 40, toolCall('r1', 'read_only')],
      [T0 + 50, toolStarted('r1')],
      [T0 + 60, toolStarted('r1')],
      [T0 + 70, toolCompleted('r1')],
      [T0 + 80, terminal('COMPLETED')],
    ]);
    expect(facts).toMatchObject({ repeatedStarts: 0, sideEffectingCalls: 1 });
    expect(totalOf([facts]).duplicates.journal).toEqual({ k: 0, n: 1 });
  });

  it('a second start of a side-effecting call after a reconcile not_applied is not a repeat', () => {
    const facts = fold('r1', [
      [T0, started(1)],
      [T0 + 10, toolCall('w1', 'exec')],
      [T0 + 20, toolStarted('w1')],
      [T0 + 30, reconciled('w1', 'not_applied')],
      [T0 + 40, toolStarted('w1')],
      [T0 + 50, toolCompleted('w1')],
      [T0 + 60, terminal('COMPLETED')],
    ]);
    expect(facts.repeatedStarts).toBe(0);
  });
});
