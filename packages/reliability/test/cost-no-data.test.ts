import { describe, expect, it } from 'vitest';
import { COST_UNIT_DIGITS, INDICATOR_DEFINITIONS_VERSION } from '@momonga/protocol';
import type { RunCostView, RunFactsView } from '@momonga/protocol';
import { aggregate, buildReliabilityReport, costOf, decodeReliabilityReport, encodeReliabilityReport, formatReliabilityReport } from '@momonga/reliability';

const NOW = 1_800_000_000_000;
const USD = 10n ** BigInt(COST_UNIT_DIGITS);

const row = (runId: string): RunFactsView => ({
  runId,
  rootRunId: runId,
  sessionId: 'sess',
  definitionsVersion: INDICATOR_DEFINITIONS_VERSION,
  model: 'apple/fm',
  mode: 'manual',
  agent: 'build',
  origin: 'cli',
  status: 'COMPLETED',
  createdAt: NOW - 20,
  endedAt: NOW - 10,
  elapsedMs: 10,
  humanWaitMs: 0,
  tokensTotal: 10,
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
  mutated: false,
  owed: false,
  verification: { rounds: 0, firstRoundPassed: null, failedRounds: 0, checkMs: 0, fixRoundTokens: 0 },
  answers: { allowOnce: 0, allowAlways: 0, rejectOnce: 0, rejectAlways: 0 },
  denials: { sandbox: 0, rule: 0, mode: 0, setting: 0, hook: 0, mandate: 0, superseded: 0, held: 0 },
  basis: { readOnly: 0, rule: 0, mode: 0, hook: 0, classifier: 0, person: 0 },
  declared: true,
  met: true,
  recoveries: [],
});

const cost = (runId: string, calls: number, units: bigint): RunCostView => ({
  runId,
  calls,
  notPriced: 0,
  legacyPrecisionCalls: 0,
  priced: calls === 0 ? [] : [{ currency: 'USD', priceVersion: '2026-01', units: units.toString() }],
});

describe('store-protocol-C17: a task without a billed call has no cost data', () => {
  const aggregated = aggregate([row('run-priced'), row('run-silent')], { groupBy: 'model' });
  const costs = costOf(aggregated, [cost('run-priced', 2, USD / 10n), cost('run-silent', 0, 0n)]);

  it('is not fully priced and is counted as without cost data', () => {
    expect(costs.total.successful).toMatchObject({ tasks: 2, fullyPriced: 1, noData: 1 });
  });

  it('is printed under no data, and the per run amount is over the runs with data', () => {
    const report = buildReliabilityReport({ kind: 'real', aggregate: aggregated, cost: costs });
    const line = formatReliabilityReport(report)
      .split('\n')
      .find((text) => text.startsWith('Cost per Successful Task: '));
    expect(line).toContain('without cost data: 1');
    expect(line).toContain('USD 0.1 per task');
    expect(decodeReliabilityReport(encodeReliabilityReport(report))).toEqual(report);
  });
});
