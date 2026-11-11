import { describe, expect, it } from 'vitest';
import { INDICATOR_DEFINITIONS_VERSION, RELIABILITY_FORMAT, RETIRED_RELIABILITY_FORMATS } from '@momonga/protocol';
import type { RunFactsView } from '@momonga/protocol';
import { aggregate, buildReliabilityReport, decodeReliabilityReport, encodeReliabilityReport, explainOf, formatReliabilityReport, indicatorsOf, withinPeriod } from '@momonga/reliability';
import type { Indicators } from '@momonga/reliability';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

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
  createdAt: NOW - 20,
  endedAt: NOW - 10,
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
  mutated: false,
  owed: false,
  verification: { rounds: 0, firstRoundPassed: null, failedRounds: 0, checkMs: 0, fixRoundTokens: 0 },
  answers: { allowOnce: 0, allowAlways: 0, rejectOnce: 0, rejectAlways: 0 },
  denials: { sandbox: 0, rule: 0, mode: 0, setting: 0, hook: 0, mandate: 0, superseded: 0, held: 0 },
  basis: { readOnly: 0, rule: 0, mode: 0, hook: 0, classifier: 0, person: 0 },
  declared: true,
  met: true,
  recoveries: [],
  ...overrides,
});

const populationOf = ({ buckets }: Indicators): number => Object.values(buckets).reduce((sum, count) => sum + count, 0);

describe('store-protocol-C16: a period or a grouping applies to every bucket printed for it', () => {
  it('does not count an unavailable root from ten days ago in a one-day period and names it as not placed', () => {
    const windowed = withinPeriod(aggregate([row('run-recent', { endedAt: NOW - DAY / 2 })], { groupBy: 'model', unavailableRoots: ['run-poison'] }), {
      days: 1,
      fromMs: NOW - DAY,
      toMs: NOW,
    });
    const { total } = indicatorsOf(windowed);
    expect(total.buckets).toEqual({ counted: 1, cancelled: 0, pendingFacts: 0, factsUnavailable: 0, unknownValues: 0, notPlaced: 1 });
    expect(explainOf(windowed).get('not placed')).toEqual(['run-poison']);
  });

  it('counts a task with only child rows as not placed, never as pending facts', () => {
    const { total } = indicatorsOf(aggregate([row('run-child', { rootRunId: 'run-running-root' })], { groupBy: 'model' }));
    expect(total.buckets.pendingFacts).toBe(0);
    expect(total.buckets.notPlaced).toBe(1);
  });

  it('makes the group populations and the not placed count add up to the total', () => {
    const rows = [row('run-a'), row('run-b', { model: 'ollama/qwen' }), row('run-b-child', { rootRunId: 'run-b', model: 'ollama/qwen' }), row('run-orphan', { rootRunId: 'run-gone', model: 'other' })];
    const { total, groups } = indicatorsOf(aggregate(rows, { groupBy: 'model', unavailableRoots: ['run-poison', 'run-b'] }));
    expect(Object.keys(groups).sort()).toEqual(['apple/fm', 'ollama/qwen']);
    const grouped = Object.values(groups).reduce((sum, group) => sum + populationOf(group), 0);
    expect(grouped + total.buckets.notPlaced).toBe(populationOf(total));
    expect(total.buckets.notPlaced).toBe(2);
  });

  it('prints the not placed count beside the terminal roots and keeps it through the codec', () => {
    const report = buildReliabilityReport({ kind: 'real', aggregate: aggregate([row('run-a')], { groupBy: 'model', unavailableRoots: ['run-poison'] }) });
    const population = formatReliabilityReport(report).split('\n').find((line) => line.startsWith('Population: '));
    expect(population).toContain('1 terminal root runs');
    expect(population).toContain('not placed 1');
    expect(decodeReliabilityReport(encodeReliabilityReport(report))).toEqual(report);
    expect(Object.hasOwn(RETIRED_RELIABILITY_FORMATS, 'momonga-reliability/4')).toBe(true);
    expect(RELIABILITY_FORMAT).toBe('momonga-reliability/6');
  });
});
