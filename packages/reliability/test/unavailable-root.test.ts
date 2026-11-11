import { INDICATOR_DEFINITIONS_VERSION } from '@momonga/protocol';
import type { RunFactsView } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import { aggregate, explainOf, indicatorsOf, withinPeriod } from '../src/aggregate.ts';

const T0 = 1_800_000_000_000;
const PERIOD = { days: 1, fromMs: T0, toMs: T0 + 86_400_000 };

const row = (runId: string, overrides: Partial<RunFactsView> = {}): RunFactsView => ({
  runId,
  rootRunId: runId,
  sessionId: 'sess',
  definitionsVersion: INDICATOR_DEFINITIONS_VERSION,
  model: 'apple/fm',
  mode: 'manual',
  agent: 'build',
  origin: 'cli',
  status: 'COMPLETED',
  createdAt: T0,
  endedAt: T0 + 10,
  elapsedMs: 10,
  humanWaitMs: 0,
  tokensTotal: 0,
  costNano: 0,
  steps: 1,
  limits: {},
  asked: 0,
  elicited: 0,
  authorizationRequired: 0,
  sideEffectingCalls: 0,
  repeatedStarts: 0,
  reconciledAlreadyApplied: 0,
  reconciledNotApplied: 0,
  reconciledUnknown: 0,
  basis: { readOnly: 0, rule: 0, mode: 0, hook: 0, classifier: 0, person: 0 },
  declared: true,
  met: true,
  recoveries: [],
  ...overrides,
});

describe('withinPeriod: a task with no readable root', () => {
  it('counts a task whose root row is missing as not placed, not as pending facts', () => {
    const aggregated = withinPeriod(aggregate([row('run-child', { rootRunId: 'run-root' })], { groupBy: 'model' }), PERIOD);
    expect([...aggregated.unavailableRoots]).toEqual([]);
    const { total } = indicatorsOf(aggregated);
    expect(total.buckets).toEqual({ counted: 0, cancelled: 0, pendingFacts: 0, factsUnavailable: 0, unknownValues: 0, notPlaced: 1 });
    expect(explainOf(aggregated).get('not placed')).toEqual(['run-root']);
  });

  it('keeps a task whose root is in the period counted', () => {
    const aggregated = withinPeriod(aggregate([row('run-root', { endedAt: T0 + 10 }), row('run-child', { rootRunId: 'run-root' })], { groupBy: 'model' }), PERIOD);
    expect(aggregated.unavailableRoots.size).toBe(0);
    expect(indicatorsOf(aggregated).total.buckets.counted).toBe(1);
  });
});
