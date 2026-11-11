import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { buildCostBreakdown, summarizeRun } from '@momonga/observability';
import { RUN_API_SCHEMAS } from '@momonga/protocol';
import { harness, billedCallsOfRun, costReportOfSpans } from '../packages/observability/test/helpers.ts';
import { TABLE, asBreakdownCall, recordCalls } from '../packages/observability/test/cache-read-fixtures.ts';
import type { CallSpec } from '../packages/observability/test/cache-read-fixtures.ts';

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
addFormats.default(ajv);
const acceptsCostReport = ajv.compile(RUN_API_SCHEMAS.CostReport);
const acceptsBreakdown = ajv.compile(RUN_API_SCHEMAS.CostBreakdown);
const acceptsTrace = ajv.compile(RUN_API_SCHEMAS.RunTrace);

const MIXES: Record<string, readonly CallSpec[]> = {
  'no call': [],
  'every call reported': [{ input: 100, cached: 40 }, { input: 50, cached: 0 }],
  'one of two reported': [{ input: 100, cached: 40 }, { input: 50 }],
  'no call reported, metered': [{ input: 100 }, { input: 50 }],
  'no call reported, local': [{ billing: 'local', input: 100 }],
  'no call reported, plan and unknown billing': [{ billing: 'plan', input: 100 }, { billing: 'unknown', input: 30 }],
};

const surfacesOf = async (specs: readonly CallSpec[]) => {
  const h = harness();
  await recordCalls(h, 'run-a', specs);
  const report = costReportOfSpans(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: TABLE });
  const breakdown = buildCostBreakdown(billedCallsOfRun(h.store, 'run-a', TABLE).map(asBreakdownCall), {});
  const summary = summarizeRun(h.store, 'run-a');
  return { report, breakdown, summary };
};

const errorsOf = (validate: { errors?: unknown }): string => JSON.stringify(validate.errors ?? null);

describe('the cost, breakdown and run-summary wires hold null for a figure no call reported', () => {
  for (const [name, specs] of Object.entries(MIXES)) {
    it(`${name}: the product output is valid on the wire and null exactly when calls exist and none reported`, async () => {
      const { report, breakdown, summary } = await surfacesOf(specs);
      const n = specs.length;
      const p = specs.filter((spec) => spec.cached !== undefined).length;
      const absent = n > 0 && p === 0;

      expect(acceptsCostReport({ ...report, contextCharges: { charges: [], totalTokens: 0 } }), errorsOf(acceptsCostReport)).toBe(true);
      expect(acceptsBreakdown(breakdown), errorsOf(acceptsBreakdown)).toBe(true);
      expect(acceptsTrace({ runId: 'run-a', summary: { ...summary, chatResults: [] }, spans: [] }), errorsOf(acceptsTrace)).toBe(true);

      expect(report.total.cachedInputTokens === null).toBe(absent);
      expect(report.runs[0]?.cachedInputTokens === null).toBe(absent);
      expect(summary.cachedInputTokens === null).toBe(absent);
      expect(breakdown.billed.cacheReadTokens === null).toBe(absent);
      expect(breakdown.billed.uncachedInputTokens === null).toBe(absent);
      expect(breakdown.billed.reportedInputTokens === null).toBe(absent);
      expect(breakdown.billed.cacheWriteTokens === null).toBe(absent);
      expect(typeof report.total.cacheReadUnpricedCalls).toBe('number');
    });
  }
});

describe('the closed wire schemas', () => {
  const totals = {
    calls: 1,
    localCalls: 0,
    unpricedCalls: 0,
    unknownBillingCalls: 0,
    cacheReadNotReportedCalls: 1,
    cacheReadUnpricedCalls: 1,
    priceNotRecordedCalls: 0, legacyPrecisionCalls: 0,
    planCalls: 0,
    planInputTokens: 0,
    planOutputTokens: 0,
    inputTokens: 100,
    outputTokens: 2,
    cachedInputTokens: null,
    amount: null,
    currency: 'USD',
    priceVersions: [],
    unpriced: { cache_read_not_reported: 1 },
    roles: {},
  };
  const report = (total: Record<string, unknown>) => ({ runs: [], sessions: [], total, contextCharges: { charges: [], totalTokens: 0 } });

  it('accepts null cached input and requires cacheReadUnpricedCalls in the cost totals', () => {
    const { cacheReadUnpricedCalls: _count, ...withoutCount } = totals;

    expect(acceptsCostReport(report(totals)), errorsOf(acceptsCostReport)).toBe(true);
    expect(acceptsCostReport(report(withoutCount))).toBe(false);
  });

  it('accepts null cache figures and requires reportedInputTokens in the breakdown', async () => {
    const { breakdown } = await surfacesOf(MIXES['no call reported, metered'] ?? []);
    const { reportedInputTokens: _reported, ...withoutReported } = breakdown.billed;

    expect(acceptsBreakdown({ ...breakdown, billed: { ...breakdown.billed, reportedInputTokens: null, uncachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null } }), errorsOf(acceptsBreakdown)).toBe(true);
    expect(acceptsBreakdown({ ...breakdown, billed: withoutReported })).toBe(false);
  });

  it('accepts a null cached input in the run summary', () => {
    const summary = { steps: 1, chatCalls: 1, sideCalls: 0, toolCalls: 0, inputTokens: 100, outputTokens: 2, cachedInputTokens: null, cacheReadNotReportedCalls: 1, errorCount: 0, durationMs: 1, chatResults: [] };

    expect(acceptsTrace({ runId: 'run-a', summary, spans: [] }), errorsOf(acceptsTrace)).toBe(true);
  });
});
