import { describe, expect, it } from 'vitest';
import { COST_UNIT_DIGITS, INDICATOR_DEFINITIONS_VERSION } from '@momonga/protocol';
import type { RunCostView, RunFactsView } from '@momonga/protocol';
import * as reliability from '@momonga/reliability';
import { aggregate, buildReliabilityReport, decodeReliabilityReport, encodeReliabilityReport, formatReliabilityReport, indicatorsOf, merge } from '@momonga/reliability';
import type { Aggregate } from '@momonga/reliability';

type Amount = { currency: 'USD'; priceVersion: string; units: string };
type Side = { tasks: number; fullyPriced: number; calls: number; notPriced: number; tokens: number; priced: Amount[] };
type Cost = { successful: Side; unsuccessful: Side };
type CostGroups = { total: Cost; groups: Record<string, Cost> };
type Period = { days: number; fromMs: number; toMs: number };
type Added = {
  withinPeriod(aggregated: Aggregate, period: Period): Aggregate;
  countedRunIdsOf(aggregated: Aggregate): string[];
  costOf(aggregated: Aggregate, costs: readonly RunCostView[]): CostGroups;
};

const added = reliability as unknown as Added;

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const USD = 10n ** BigInt(COST_UNIT_DIGITS);

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
  basis: { readOnly: 0, rule: 0, mode: 0, hook: 0, classifier: 0, person: 0 },
  declared: true,
  met: true,
  recoveries: [],
  ...overrides,
});

const period = (days: number): Period => ({ days, fromMs: NOW - days * DAY, toMs: NOW });

describe('the period of a report (2.2, gap B)', () => {
  const recent = row('run-recent', { endedAt: NOW - DAY });
  const old = row('run-old', { endedAt: NOW - 31 * DAY });
  const oldChild = row('run-old-child', { rootRunId: 'run-old', endedAt: NOW - DAY, asked: 1 });
  const edge = row('run-edge', { endedAt: NOW - 30 * DAY });

  it('keeps the tasks whose root run ended in the period, whatever the end of their child runs', () => {
    const windowed = added.withinPeriod(aggregate([recent, old, oldChild, edge], { groupBy: 'model' }), period(30));
    expect([...windowed.tasks.keys()].sort()).toEqual(['run-edge', 'run-recent']);
    expect(indicatorsOf(windowed).total.buckets.counted).toBe(2);
    expect(indicatorsOf(windowed).total.intervention.k).toBe(0);
  });

  it('gives the same tasks whatever the pages the rows of a tree arrived in', () => {
    const paged = merge(aggregate([oldChild, recent], { groupBy: 'model' }), aggregate([old, edge], { groupBy: 'model' }));
    expect([...added.withinPeriod(paged, period(30)).tasks.keys()].sort()).toEqual(['run-edge', 'run-recent']);
  });

  it('keeps a task whose root row is not there, as pending facts, and an unavailable root that has no row', () => {
    const orphan = row('run-orphan-child', { rootRunId: 'run-orphan', endedAt: NOW - 90 * DAY });
    const windowed = added.withinPeriod(aggregate([orphan, old], { groupBy: 'model', unavailableRoots: ['poison', 'run-old'] }), period(30));
    const { buckets } = indicatorsOf(windowed).total;
    expect(buckets).toMatchObject({ counted: 0, pendingFacts: 1, factsUnavailable: 1 });
  });

  it('is printed in the population block of a real report and survives the codec', () => {
    const report = buildReliabilityReport({ kind: 'real', aggregate: aggregate([recent], { groupBy: 'model' }), period: { days: 30, fromMs: Date.UTC(2026, 9, 12), toMs: Date.UTC(2026, 10, 11) } } as never);
    const lines = formatReliabilityReport(report).split('\n');
    expect(lines[1]).toBe('Period: tasks whose root run ended in the last 30 days (2026-10-12T00:00:00.000Z to 2026-11-11T00:00:00.000Z)');
    expect(lines[2]?.startsWith('Population: ')).toBe(true);
    expect(decodeReliabilityReport(encodeReliabilityReport(report))).toEqual(report);
  });
});

describe('Cost per Successful Task (X6)', () => {
  const rows = [
    row('run-met', { tokensTotal: 3000 }),
    row('run-met-child', { rootRunId: 'run-met', tokensTotal: 1000 }),
    row('run-met-2', { tokensTotal: 1000 }),
    row('run-failed', { status: 'FAILED', met: false, tokensTotal: 500 }),
    row('run-cancelled', { status: 'CANCELLED', met: false }),
    row('run-stale', { definitionsVersion: INDICATOR_DEFINITIONS_VERSION + 1 }),
  ];
  const aggregated = aggregate(rows, { groupBy: 'model' });
  const cost = (runId: string, calls: number, notPriced: number, priced: [string, bigint][]): RunCostView => ({
    runId,
    calls,
    notPriced,
    priced: priced.map(([priceVersion, units]) => ({ currency: 'USD', priceVersion, units: units.toString() })),
  });
  const costs = [
    cost('run-met', 2, 0, [['2026-01', USD / 100n]]),
    cost('run-met-child', 1, 1, [['2026-01', USD / 100n]]),
    cost('run-met-2', 2, 0, [
      ['2026-01', USD / 50n],
      ['local', 0n],
    ]),
    cost('run-failed', 3, 0, [['2026-01', USD / 4n]]),
  ];

  it('names every run of the counted tasks, and no run of a cancelled or pending task', () => {
    expect(added.countedRunIdsOf(aggregated)).toEqual(['run-failed', 'run-met', 'run-met-2', 'run-met-child']);
  });

  it('sums the priced units per price version over the trees of the successful tasks, counts the calls not priced and the tasks fully priced, and puts the tasks that did not succeed beside', () => {
    const { total, groups } = added.costOf(aggregated, costs);
    expect(total.successful).toEqual({
      tasks: 2,
      fullyPriced: 1,
      calls: 5,
      notPriced: 1,
      tokens: 4000,
      priced: [
        { currency: 'USD', priceVersion: '2026-01', units: (USD / 25n).toString() },
        { currency: 'USD', priceVersion: 'local', units: '0' },
      ],
    });
    expect(total.unsuccessful).toEqual({ tasks: 1, fullyPriced: 1, calls: 3, notPriced: 0, tokens: 500, priced: [{ currency: 'USD', priceVersion: '2026-01', units: (USD / 4n).toString() }] });
    expect(groups).toEqual({ 'apple/fm': total });
  });

  it('refuses costs that leave out a run of a counted task', () => {
    expect(() => added.costOf(aggregated, costs.slice(1))).toThrow(/run-met/);
  });

  it('prints the mean per price version, the calls not priced, the partial sentence and the tokens, and the price of failing beside', () => {
    const report = buildReliabilityReport({ kind: 'real', aggregate: aggregated, cost: added.costOf(aggregated, costs) } as never);
    const lines = formatReliabilityReport(report).split('\n');
    expect(lines).toContain(
      'Cost per Successful Task: n=2; USD 0.02 per task (price version 2026-01, total USD 0.04), USD 0 per task (price version local, total USD 0); 1 of 5 calls not priced; partial: 1 of 2 successful tasks fully priced; tokens per successful task 2000',
    );
    expect(lines).toContain('Cost of tasks that did not succeed: n=1; total USD 0.25 (price version 2026-01); 0 of 3 calls not priced; tokens 500');
    expect(lines.filter((line) => line.startsWith('Cost per Successful Task'))).toHaveLength(2);
    expect(decodeReliabilityReport(encodeReliabilityReport(report))).toEqual(report);
  });

  it('says not measurable when no task succeeded, and prints no cost line in a report built without costs', () => {
    const failed = aggregate([rows[3] as RunFactsView], { groupBy: 'model' });
    const text = formatReliabilityReport(buildReliabilityReport({ kind: 'real', aggregate: failed, cost: added.costOf(failed, [costs[3] as RunCostView]) } as never));
    expect(text.split('\n')).toContain('Cost per Successful Task: not measurable: no successful task');
    expect(formatReliabilityReport(buildReliabilityReport({ kind: 'real', aggregate: failed }))).not.toContain('Cost');
  });
});
