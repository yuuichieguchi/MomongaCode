import { describe, expect, it } from 'vitest';
import { formatCostReport } from '@momonga/observability';
import { harness, costReportOfSpans } from './helpers.ts';
import { TABLE, recordCalls } from './cache-read-fixtures.ts';
import type { CallSpec } from './cache-read-fixtures.ts';

const METERED_TEXT = 'call(s) are metered and did not report cache reads, so their price is unknown and they are not counted in the amount';
const DELETED_CLAUSE = 'did not report cache reads and are not counted in the cached tokens or the amount';

const reportOf = async (specs: readonly CallSpec[]) => {
  const h = harness();
  await recordCalls(h, 'run-a', specs);
  const report = costReportOfSpans(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: TABLE });
  const text = formatCostReport(report);
  const totalLine = text.split('\n').find((line) => line.startsWith('  total: ')) ?? '';
  return { report, text, totalLine };
};

const occurrences = (text: string, part: string): number => text.split(part).length - 1;

describe('/cost names the call set of its cached figure', () => {
  it('keeps the plain clause when every call reported its cache reads', async () => {
    const { totalLine } = await reportOf([{ input: 1000, cached: 800 }, { input: 1000, cached: 0 }]);

    expect(totalLine).toContain('2 call(s), 2000 input (800 cached) + 4 output tokens');
  });

  it('counts the input of every call and the cached input of the reporting calls, and says so with P of N and U', async () => {
    const { report, totalLine, text } = await reportOf([{ input: 1000, cached: 800 }, { input: 1000 }]);

    expect(totalLine).toContain('2000 input (800 cached in 1 of 2 call(s); cache reads not reported in 1 call(s)) + 4 output tokens');
    expect(report.total.inputTokens).toBe(2000);
    expect(report.total.cachedInputTokens).toBe(800);
    expect(report.total.cacheReadNotReportedCalls).toBe(1);
    expect(text).not.toContain(DELETED_CLAUSE);
  });

  it('prints the not-reported form and a null figure, never 0, when no call reported', async () => {
    const { report, totalLine } = await reportOf([{ input: 1000 }, { input: 1000 }]);

    expect(totalLine).toContain('2000 input (cached not reported: cache reads not reported in all 2 call(s)) + 4 output tokens');
    expect(report.total.cachedInputTokens).toBeNull();
    expect(report.runs[0]?.cachedInputTokens).toBeNull();
    expect(report.sessions[0]?.cachedInputTokens).toBeNull();
  });
});

describe('/cost counts a cost exclusion through the price outcome only', () => {
  it('counts a metered unreported call in cacheReadUnpricedCalls, prints the money line once, and leaves its price out of the priced part', async () => {
    const { report, totalLine } = await reportOf([{ input: 1000, cached: 800 }, { input: 1000 }]);

    expect(report.total.cacheReadUnpricedCalls).toBe(1);
    expect(report.total.unpricedCalls).toBe(0);
    expect(report.total.unpriced).toEqual({ cache_read_not_reported: 1 });
    expect(report.total.amount).toBe(0.000816);
    expect(occurrences(totalLine, 'not complete: ')).toBe(1);
    expect(totalLine).toMatch(/ output tokens, not complete: cache reads not reported in 1 call\(s\); priced part: 0\.000816 USD over 1 of 2 call\(s\)$/);
    expect(totalLine).not.toContain(METERED_TEXT);
  });

  it('keeps a local unreported call in the cached clause and prints the whole figure with no unpriced text for it', async () => {
    const { report, totalLine } = await reportOf([{ input: 1000, cached: 800 }, { billing: 'local', input: 1000 }]);

    expect(totalLine).toContain('2000 input (800 cached in 1 of 2 call(s); cache reads not reported in 1 call(s))');
    expect(report.total.cacheReadUnpricedCalls).toBe(0);
    expect(report.total.cacheReadNotReportedCalls).toBe(1);
    expect(report.total.unpriced).toEqual({});
    expect(totalLine).not.toContain(METERED_TEXT);
    expect(totalLine).not.toContain('not complete');
    expect(totalLine).toMatch(/ output tokens, 0\.000816 USD at price version 2026-01-01$/);
  });

  it('lists an unknown-billing unreported call once for the cached figure and once for the cost, with different sentences', async () => {
    const { report, totalLine } = await reportOf([{ billing: 'unknown', input: 1000 }]);

    expect(report.total.unknownBillingCalls).toBe(1);
    expect(report.total.cacheReadUnpricedCalls).toBe(0);
    expect(report.total.cacheReadNotReportedCalls).toBe(1);
    expect(totalLine).toContain('1000 input (cached not reported: cache reads not reported in all 1 call(s))');
    expect(report.total.unpriced).toEqual({ unknown_billing: 1 });
    expect(report.total.amount).toBeNull();
    expect(occurrences(totalLine, 'billing unknown')).toBe(1);
    expect(totalLine).toMatch(/ output tokens, not complete: billing unknown in 1 call\(s\)$/);
    expect(totalLine).not.toContain(METERED_TEXT);
    expect(totalLine).not.toContain(DELETED_CLAUSE);
  });

  it('keeps a plan unreported call out of every cost count for this reason', async () => {
    const { report, totalLine } = await reportOf([{ billing: 'plan', input: 1000 }, { input: 500, cached: 100 }]);

    expect(report.total.cacheReadUnpricedCalls).toBe(0);
    expect(report.total.planCalls).toBe(1);
    expect(totalLine).toContain('1500 input (100 cached in 1 of 2 call(s); cache reads not reported in 1 call(s))');
    expect(totalLine).not.toContain(METERED_TEXT);
  });

  it('sums cacheReadUnpricedCalls of the runs into the session and the total, and per role', async () => {
    const { report } = await reportOf([{ input: 1000 }, { input: 10 }, { input: 10, cached: 0 }]);

    expect(report.runs[0]?.cacheReadUnpricedCalls).toBe(2);
    expect(report.sessions[0]?.cacheReadUnpricedCalls).toBe(2);
    expect(report.total.cacheReadUnpricedCalls).toBe(2);
    expect(Object.values(report.total.roles).reduce((sum, role) => sum + role.cacheReadUnpricedCalls, 0)).toBe(2);
  });
});
