import { describe, expect, it } from 'vitest';
import { INDICATOR_DEFINITIONS_VERSION } from '@momonga/protocol';
import { aggregate, foldFacts, indicatorsOf } from '@momonga/reliability';
import type { RunFacts } from '@momonga/reliability';
import {
  T0,
  attemptFailed,
  authorizationRequired,
  elicitationRequested,
  eventsOf,
  modelRequested,
  permissionClassifiedAllow,
  permissionRequested,
  reconciled,
  runInfo,
  started,
  status,
  terminal,
  toolCall,
  toolCompleted,
  toolStarted,
} from './streams.ts';
import type { Timed } from './streams.ts';

const fold = (runId: string, timed: readonly Timed[], info: Partial<Parameters<typeof runInfo>[0]> = {}): RunFacts =>
  foldFacts(eventsOf(runId, timed), runInfo({ runId, ...info }));

const totalOf = (rows: readonly RunFacts[]) => indicatorsOf(aggregate(rows, { groupBy: 'model' })).total;

const crashThenReconcile = (outcome: 'already_applied' | 'unknown'): Timed[] => [
  [T0, started(1, { declared: true })],
  [T0 + 1000, toolCall('c1', 'write')],
  [T0 + 1010, toolStarted('c1')],
  [T0 + 5000, started(2, { recovery: { cause: 'process_lost', failedAt: T0 + 2000 } })],
  [T0 + 5100, reconciled('c1', outcome)],
  [T0 + 5200, modelRequested(2)],
  [T0 + 6000, terminal('COMPLETED')],
];

describe('foldFacts: the per-run facts', () => {
  it('stamps the definitions version and the run identity', () => {
    const facts = fold('r1', [
      [T0, started(1)],
      [T0 + 10, terminal('COMPLETED')],
    ]);
    expect(facts).toMatchObject({ runId: 'r1', rootRunId: 'r1', definitionsVersion: INDICATOR_DEFINITIONS_VERSION, status: 'COMPLETED', endedAt: T0 + 10, elapsedMs: 10 });
  });

  it('reads the declaration from run.started.pins.mandate.completion and met from the root status', () => {
    expect(fold('r1', [[T0, started(1, { declared: true })], [T0 + 1, terminal('COMPLETED')]])).toMatchObject({ declared: true, met: true });
    expect(fold('r2', [[T0, started(1, { declared: true })], [T0 + 1, terminal('FAILED')]], { status: 'FAILED' })).toMatchObject({ declared: true, met: false });
    expect(fold('r3', [[T0, started(1)], [T0 + 1, terminal('COMPLETED')]])).toMatchObject({ declared: false, met: true });
  });
});

describe('X2 Recovery Success Rate and X9 Mean Recovery Time', () => {
  it('a reconcile already_applied then progress is recovered, and it is prevented, never a duplicate', () => {
    const facts = fold('r1', crashThenReconcile('already_applied'));
    expect(facts.recoveries).toEqual([
      expect.objectContaining({ ordinal: 1, cause: 'process_lost', failedAt: T0 + 2000, progressAt: T0 + 5200, outcome: 'recovered' }),
    ]);
    expect(facts).toMatchObject({ reconciledAlreadyApplied: 1, reconciledUnknown: 0, repeatedStarts: 0, sideEffectingCalls: 1 });
    const total = totalOf([facts]);
    expect(total.recovery).toEqual({ k: 1, n: 1, unknownEffect: 0, failed: 0 });
    expect(total.recoveryTime).toEqual({ n: 1, meanMs: 3200, medianMs: 3200, clockSkew: 0 });
    expect(total.duplicates).toEqual({ journal: { k: 0, n: 1 }, prevented: 1, unknown: 0 });
  });

  it('a reconcile unknown is unknown_effect, not recovered (O-1), and stays out of the mean', () => {
    const facts = fold('r1', crashThenReconcile('unknown'));
    expect(facts.recoveries.map((episode) => episode.outcome)).toEqual(['unknown_effect']);
    const total = totalOf([facts]);
    expect(total.recovery).toEqual({ k: 0, n: 1, unknownEffect: 1, failed: 0 });
    expect(total.recoveryTime).toEqual({ n: 0, meanMs: null, medianMs: null, clockSkew: 0 });
    expect(total.duplicates).toEqual({ journal: { k: 0, n: 1 }, prevented: 0, unknown: 1 });
  });

  it('a worker failure takes failedAt from the attempt.failed it follows', () => {
    const facts = fold('r1', [
      [T0, started(1)],
      [T0 + 100, modelRequested(1)],
      [T0 + 300, attemptFailed(1, 'gateway_unavailable')],
      [T0 + 301, status('RUNNING', 'QUEUED')],
      [T0 + 900, started(2, { recovery: { cause: 'worker_failure', failedAt: T0 + 300 } })],
      [T0 + 950, modelRequested(1)],
      [T0 + 1000, terminal('COMPLETED')],
    ]);
    expect(facts.recoveries).toEqual([expect.objectContaining({ cause: 'worker_failure', failedAt: T0 + 300, progressAt: T0 + 950, outcome: 'recovered' })]);
    expect(totalOf([facts]).recoveryTime).toEqual({ n: 1, meanMs: 650, medianMs: 650, clockSkew: 0 });
  });

  it('another recovery start before progress fails the earlier episode; the later one recovers once the open call is reconciled', () => {
    const facts = fold('r1', [
      [T0, started(1)],
      [T0 + 10, toolCall('c1', 'exec')],
      [T0 + 20, toolStarted('c1')],
      [T0 + 1000, started(2, { recovery: { cause: 'process_lost', failedAt: T0 + 500 } })],
      [T0 + 2000, started(3, { recovery: { cause: 'process_lost', failedAt: T0 + 1500 } })],
      [T0 + 2100, reconciled('c1', 'not_applied')],
      [T0 + 2200, toolStarted('c1')],
      [T0 + 2300, toolCompleted('c1')],
      [T0 + 2400, terminal('COMPLETED')],
    ]);
    expect(facts.recoveries.map(({ ordinal, outcome }) => ({ ordinal, outcome }))).toEqual([
      { ordinal: 1, outcome: 'failed' },
      { ordinal: 2, outcome: 'recovered' },
    ]);
    expect(facts).toMatchObject({ repeatedStarts: 0, reconciledNotApplied: 1 });
    const total = totalOf([facts]);
    expect(total.recovery).toEqual({ k: 1, n: 2, unknownEffect: 0, failed: 1 });
    expect(total.recoveryTime).toEqual({ n: 1, meanMs: 700, medianMs: 700, clockSkew: 0 });
  });

  it('a terminal FAILED before progress is failed', () => {
    const facts = fold(
      'r1',
      [
        [T0, started(1)],
        [T0 + 1000, started(2, { recovery: { cause: 'worker_failure', failedAt: T0 + 400 } })],
        [T0 + 1100, terminal('FAILED')],
      ],
      { status: 'FAILED' },
    );
    expect(facts.recoveries.map((episode) => episode.outcome)).toEqual(['failed']);
    expect(totalOf([facts]).recovery).toEqual({ k: 0, n: 1, unknownEffect: 0, failed: 1 });
  });

  it('a recovered episode whose progress precedes failedAt is clock_skew and out of the mean, still recovered', () => {
    const facts = fold('r1', [
      [T0, started(1)],
      [T0 + 10, started(2, { recovery: { cause: 'process_lost', failedAt: T0 + 5000 } })],
      [T0 + 20, modelRequested(1)],
      [T0 + 30, terminal('COMPLETED')],
    ]);
    const total = totalOf([facts]);
    expect(total.recovery).toEqual({ k: 1, n: 1, unknownEffect: 0, failed: 0 });
    expect(total.recoveryTime).toEqual({ n: 0, meanMs: null, medianMs: null, clockSkew: 1 });
  });

  it('a first start, a wake and a drain carry no recovery and make no episode', () => {
    const facts = fold('r1', [
      [T0, started(1)],
      [T0 + 10, status('RUNNING', 'QUEUED')],
      [T0 + 20, started(1)],
      [T0 + 30, terminal('COMPLETED')],
    ]);
    expect(facts.recoveries).toEqual([]);
    expect(totalOf([facts]).recovery).toEqual({ k: 0, n: 0, unknownEffect: 0, failed: 0 });
  });

  it('the mean and median are over recovered episodes of every task', () => {
    const quick = fold('r1', [
      [T0, started(1)],
      [T0 + 100, started(2, { recovery: { cause: 'process_lost', failedAt: T0 } })],
      [T0 + 100, modelRequested(1)],
      [T0 + 200, terminal('COMPLETED')],
    ]);
    const slow = fold('r2', [
      [T0, started(1)],
      [T0 + 1000, started(2, { recovery: { cause: 'process_lost', failedAt: T0 } })],
      [T0 + 1000, modelRequested(1)],
      [T0 + 2000, terminal('COMPLETED')],
    ]);
    const slowest = fold('r3', [
      [T0, started(1)],
      [T0 + 7000, started(2, { recovery: { cause: 'process_lost', failedAt: T0 } })],
      [T0 + 7000, modelRequested(1)],
      [T0 + 8000, terminal('COMPLETED')],
    ]);
    expect(totalOf([quick, slow, slowest]).recoveryTime).toEqual({ n: 3, meanMs: 2700, medianMs: 1000, clockSkew: 0 });
  });
});

describe('X3 Duplicate Side Effect Rate (journal line)', () => {
  it('a second tool.started for a side-effecting call with no not_applied between is a repeated start', () => {
    const facts = fold('r1', [
      [T0, started(1)],
      [T0 + 10, toolCall('c1', 'write')],
      [T0 + 20, toolStarted('c1')],
      [T0 + 30, toolStarted('c1')],
      [T0 + 40, toolCompleted('c1')],
      [T0 + 50, terminal('COMPLETED')],
    ]);
    expect(facts).toMatchObject({ repeatedStarts: 1, sideEffectingCalls: 1 });
    expect(totalOf([facts]).duplicates).toEqual({ journal: { k: 1, n: 1 }, prevented: 0, unknown: 0 });
  });

  it('a task with only read_only calls is outside the denominator', () => {
    const readOnly = fold('r1', [
      [T0, started(1)],
      [T0 + 10, toolCall('c1', 'read_only')],
      [T0 + 20, toolStarted('c1')],
      [T0 + 30, toolCompleted('c1')],
      [T0 + 40, terminal('COMPLETED')],
    ]);
    expect(readOnly.sideEffectingCalls).toBe(0);
    expect(totalOf([readOnly]).duplicates.journal).toEqual({ k: 0, n: 0 });
  });
});

describe('X1 Task Completion Rate', () => {
  it('counts met over declared and keeps undeclared tasks out of the denominator', () => {
    const rows = [
      fold('r1', [[T0, started(1, { declared: true })], [T0 + 1, terminal('COMPLETED')]]),
      fold('r2', [[T0, started(1, { declared: true })], [T0 + 1, terminal('FAILED')]], { status: 'FAILED' }),
      fold('r3', [[T0, started(1)], [T0 + 1, terminal('COMPLETED')]]),
    ];
    expect(totalOf(rows).completion).toEqual({ k: 1, n: 1 + 1, undeclared: 1 });
  });

  it('with zero declared tasks the rate has no denominator and never falls back to COMPLETED', () => {
    const rows = [
      fold('r1', [[T0, started(1)], [T0 + 1, terminal('COMPLETED')]]),
      fold('r2', [[T0, started(1)], [T0 + 1, terminal('COMPLETED')]]),
    ];
    expect(totalOf(rows).completion).toEqual({ k: 0, n: 0, undeclared: 2 });
  });
});

describe('X4 Human Intervention Rate', () => {
  it('counts a permission ask, an elicitation and an authorization request, never a classifier allowance, grouped by mode', () => {
    const at = (payload: Parameters<typeof eventsOf>[1][number][1]): Timed[] => [
      [T0, started(1)],
      [T0 + 10, toolCall('c1', 'write')],
      [T0 + 20, payload],
      [T0 + 30, terminal('COMPLETED')],
    ];
    const rows = [
      fold('asked', at(permissionRequested('c1')), { mode: 'default' }),
      fold('classified', at(permissionClassifiedAllow('c1')), { mode: 'default' }),
      fold('elicited', at(elicitationRequested('c1')), { mode: 'bypassPermissions' }),
      fold('authorized', at(authorizationRequired()), { mode: 'bypassPermissions' }),
      fold('none', [[T0, started(1)], [T0 + 1, terminal('COMPLETED')]], { mode: 'bypassPermissions' }),
    ];
    const indicators = indicatorsOf(aggregate(rows, { groupBy: 'mode' }));
    expect(indicators.total.intervention).toEqual({ k: 3, n: 5 });
    expect(indicators.groups['default']?.intervention).toEqual({ k: 1, n: 2 });
    expect(indicators.groups['bypassPermissions']?.intervention).toEqual({ k: 2, n: 3 });
  });

  it('counts a task once when only a child run asked', () => {
    const root = fold('root', [[T0, started(1)], [T0 + 100, terminal('COMPLETED')]]);
    const child = fold(
      'child',
      [
        [T0 + 10, started(1)],
        [T0 + 20, toolCall('c1', 'write')],
        [T0 + 30, permissionRequested('c1')],
        [T0 + 40, permissionRequested('c1')],
        [T0 + 50, terminal('COMPLETED')],
      ],
      { rootRunId: 'root' },
    );
    expect(totalOf([root, child]).intervention).toEqual({ k: 1, n: 1 });
  });
});

describe('X5 Budget Overrun Rate', () => {
  const ended = (runId: string, endAt: number, info: Partial<Parameters<typeof runInfo>[0]>): RunFacts =>
    fold(runId, [[T0, started(1)], [endAt, terminal(info.status ?? 'COMPLETED')]], info);

  it('counts spent over limit in any dimension; a budget stop at the limit is a budget stop, not an overrun', () => {
    const rows = [
      ended('tokens-at-limit', T0 + 1000, { limits: { maxTotalTokens: 1000 }, tokensTotal: 1000, status: 'STOPPED', stopReason: 'budget' }),
      ended('tokens-over', T0 + 1000, { limits: { maxTotalTokens: 1000 }, tokensTotal: 1001, status: 'STOPPED', stopReason: 'budget' }),
      ended('summary-step', T0 + 1000, { limits: { maxSteps: 10 }, step: 11 }),
      ended('steps-over', T0 + 1000, { limits: { maxSteps: 10 }, step: 12 }),
      ended('deadline-passed', T0 + 5001, { deadlineAt: T0 + 5000 }),
      ended('deadline-met', T0 + 5000, { deadlineAt: T0 + 5000 }),
      ended('no-limit', T0 + 1000, { tokensTotal: 10_000_000, step: 500 }),
    ];
    expect(totalOf(rows).overrun).toEqual({ k: 3, n: 6, budgetStops: 2 });
  });
});

describe('X7 Time per Successful Task', () => {
  it('averages active time (elapsed minus WAITING_HUMAN) and elapsed time over successful tasks only', () => {
    const waited = fold('waited', [
      [T0, started(1, { declared: true })],
      [T0 + 1000, status('RUNNING', 'WAITING_HUMAN')],
      [T0 + 4000, status('WAITING_HUMAN', 'RUNNING')],
      [T0 + 6000, terminal('COMPLETED')],
    ]);
    expect(waited).toMatchObject({ elapsedMs: 6000, humanWaitMs: 3000 });
    const quick = fold('quick', [[T0, started(1, { declared: true })], [T0 + 2000, terminal('COMPLETED')]]);
    const failed = fold('failed', [[T0, started(1, { declared: true })], [T0 + 9000, terminal('FAILED')]], { status: 'FAILED' });
    expect(totalOf([waited, quick, failed]).time).toEqual({ n: 2, meanActiveMs: 2500, meanElapsedMs: 4000 });
  });
});

describe('population buckets', () => {
  it('a cancelled root is printed and excluded from every rate; facts at an older definitions version are pending', () => {
    const cancelled = fold('cancelled', [[T0, started(1)], [T0 + 10, toolCall('c1', 'write')], [T0 + 20, permissionRequested('c1')], [T0 + 30, terminal('CANCELLED')]], {
      status: 'CANCELLED',
    });
    const stale: RunFacts = { ...fold('stale', [[T0, started(1)], [T0 + 1, terminal('COMPLETED')]]), definitionsVersion: INDICATOR_DEFINITIONS_VERSION - 1 };
    const counted = fold('counted', [[T0, started(1)], [T0 + 1, terminal('COMPLETED')]]);
    const total = totalOf([cancelled, stale, counted]);
    expect(total.buckets).toEqual({ counted: 1, cancelled: 1, pendingFacts: 1 });
    expect(total.intervention).toEqual({ k: 0, n: 1 });
  });
});
