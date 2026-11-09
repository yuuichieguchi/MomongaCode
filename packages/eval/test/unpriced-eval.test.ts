import { describe, expect, it } from 'vitest';
import { CONTEXT_DATASET_FORMAT, CONTEXT_REPORT_FORMAT, compareContextReports, encodeContextReport, formatContextReport, parseContextDataset, parseContextReport } from '@momonga/eval';
import type { ContextReport } from '@momonga/eval';
import type { RunEventPayload } from '@momonga/protocol';
import { contextCase, recorded } from './context-fixtures.ts';
import { buildReportAs, withMeasuredQuality } from './answered-fixtures.ts';

const SCENARIOS = ['a', 'b', 'c', 'd'] as const;
const CASE_IDS = SCENARIOS.flatMap((scenario) => [`${scenario}-on`, `${scenario}-off`]);

const dataset = parseContextDataset(
  JSON.stringify({
    format: CONTEXT_DATASET_FORMAT,
    name: 'unpriced',
    cases: SCENARIOS.flatMap((scenario) => [contextCase(`${scenario}-on`, scenario, 'on'), contextCase(`${scenario}-off`, scenario, 'off')]),
  }),
  'unpriced.json',
);

type Outcome = { cost: number } | { unpriced: 'plan' | 'unknown_billing' | 'no_price_entry' | 'unpriceable_usage' } | 'unrecorded';

const responded = (outcome: Outcome, step: number): RunEventPayload =>
  ({
    type: 'model.responded',
    step,
    attempt: 1,
    response: {
      status: 'completed',
      output: [],
      usage: { input_tokens: 1000, output_tokens: 50, total_tokens: 1050, input_tokens_details: { cached_tokens: 400 }, output_tokens_details: { reasoning_tokens: 0 } },
      momonga: {
        cacheWriteInputTokens: 0,
        ...(outcome === 'unrecorded'
          ? {}
          : 'cost' in outcome
            ? { cost: { amount: outcome.cost, currency: 'USD', priceVersion: outcome.cost === 0 ? 'local' : '2026-01-01' } }
            : { unpriced: { code: outcome.unpriced, reason: 'why' } }),
      },
      timing: { firstEventMs: 100, durationMs: 2000 },
    },
  }) as unknown as RunEventPayload;

const PRICED: Outcome = { cost: 0.002 };

const reportOf = (outcomes: (caseId: string) => Outcome): ContextReport =>
  withMeasuredQuality(
    buildReportAs({
      dataset,
      transcripts: CASE_IDS.map((caseId) => recorded(caseId, 0, [responded(outcomes(caseId), 1)], { status: 'COMPLETED' })),
      model: 'real',
      seed: 1,
    }),
  );

const costLine = (report: ContextReport): string | undefined => formatContextReport(report).split('\n').find((line) => line.includes('costPerSuccess'));

describe('eval records why a cost is unmeasured (R-D)', () => {
  it('names plan usage in the costPerSuccess line of a plan alias', () => {
    const report = reportOf(() => ({ unpriced: 'plan' }));

    expect(report.metrics.costPerSuccess).toBeUndefined();
    expect(costLine(report)).toBe('costPerSuccess n/a (plan usage, no per-token price in 8 call(s) of 8 case(s))');
  });

  it('counts the calls of each case by code in the case totals', () => {
    const report = reportOf((caseId) => (caseId === 'b-off' ? { unpriced: 'plan' } : caseId === 'c-off' ? { unpriced: 'no_price_entry' } : PRICED));

    expect(report.cases.find((entry) => entry.id === 'b-off')?.tokens).toMatchObject({ unpriced: { plan: 1 } });
    expect(report.cases.find((entry) => entry.id === 'c-off')?.tokens).toMatchObject({ unpriced: { no_price_entry: 1 } });
    expect(report.cases.find((entry) => entry.id === 'a-on')?.tokens).not.toHaveProperty('unpriced');
  });

  it('names both codes with their counts for a mixed run', () => {
    const line = costLine(reportOf((caseId) => (caseId === 'b-off' ? { unpriced: 'plan' } : caseId === 'c-off' ? { unpriced: 'no_price_entry' } : PRICED)));

    expect(line).toContain('plan usage, no per-token price in 1 call(s) of 1 case(s)');
    expect(line).toContain('no price entry in 1 call(s) of 1 case(s)');
  });

  it('says "price not recorded" for a record with neither cost nor unpriced, and counts it apart', () => {
    const report = reportOf((caseId) => (caseId === 'a-off' ? 'unrecorded' : PRICED));

    expect(report.cases.find((entry) => entry.id === 'a-off')?.tokens).toMatchObject({ unrecordedPrice: 1 });
    expect(costLine(report)).toBe('costPerSuccess n/a (price not recorded in 1 call(s) of 1 case(s))');
  });

  it('gives compare the same text in why', () => {
    const plan = reportOf(() => ({ unpriced: 'plan' }));
    const comparison = compareContextReports(plan, { ...plan, policy: { context: { cachePrefix: true } } }, { seed: 1, gate: 'token' });
    const check = comparison.gate.checks.find((entry) => entry.name === 'uncachedInputPerSuccess');

    expect(check?.detail).toContain('plan usage, no per-token price in 8 call(s) of 8 case(s)');
  });

  it('still judges an all-local run on uncached input, its cost being 0 and no call unpriced', () => {
    const local = reportOf(() => ({ cost: 0 }));
    const comparison = compareContextReports(local, { ...local, policy: { context: { cachePrefix: true } } }, { seed: 1, gate: 'token' });

    expect(local.cases.every((entry) => entry.tokens !== undefined && !('unpriced' in entry.tokens) && !('unrecordedPrice' in entry.tokens))).toBe(true);
    expect(comparison.gate.checks.map((entry) => entry.name)).toContain('uncachedInputPerSuccess');
    expect(CONTEXT_REPORT_FORMAT).toBe('momonga-eval-context-report/5');
  });
});

describe('the context report format /5', () => {
  it('is /5, and refuses a /4 report as retired with the reason of the price outcome', () => {
    const report = reportOf(() => PRICED);
    const previous = encodeContextReport({ ...report, format: 'momonga-eval-context-report/4' } as unknown as ContextReport);

    expect(CONTEXT_REPORT_FORMAT).toBe('momonga-eval-context-report/5');
    expect(() => parseContextReport(previous, 'previous.json')).toThrow(
      'previous.json: momonga-eval-context-report/4 reports do not record the price outcome of the calls (why a cost is unmeasured), so momonga-eval-context-report/4 is retired',
    );
  });

  it('keeps the unpriced counts and the unrecorded count through a stored /5 report', () => {
    const report = reportOf((caseId) => (caseId === 'b-off' ? { unpriced: 'plan' } : caseId === 'a-off' ? 'unrecorded' : PRICED));
    const parsed = parseContextReport(encodeContextReport(report), 'stored.json');

    expect(parsed.format).toBe('momonga-eval-context-report/5');
    expect(parsed.cases.find((entry) => entry.id === 'b-off')?.tokens).toMatchObject({ unpriced: { plan: 1 } });
    expect(parsed.cases.find((entry) => entry.id === 'a-off')?.tokens).toMatchObject({ unrecordedPrice: 1 });
  });
});
