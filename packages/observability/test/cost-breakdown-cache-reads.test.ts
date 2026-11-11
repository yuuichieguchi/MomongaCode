import { describe, expect, it } from 'vitest';
import { buildCostBreakdown, formatCostBreakdown, priceCall } from '@momonga/observability';
import type { BreakdownCall } from '@momonga/observability';
import { TABLE } from './cache-read-fixtures.ts';

const AT = new Date('2026-06-01T00:00:00Z');

type Usage = BreakdownCall['usage'];

const callOf = (step: number, usage: Usage, billing: BreakdownCall['billing'] = 'metered'): BreakdownCall => {
  const identity = { runId: 'run-a', step, provider: 'acme', model: 'm1', billing, at: new Date(AT.getTime() + step), usage, prefix: { broken: false } as const };
  return { ...identity, price: priceCall({ usageSource: 'reported', provider: identity.provider, model: identity.model, billing, usage, at: identity.at, table: TABLE }) };
};

const usage = (inputTokens: number, cachedInputTokens: number | undefined, cacheWriteInputTokens = 0): Usage => ({
  inputTokens,
  ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  cacheWriteInputTokens,
  outputTokens: 10,
  reasoningTokens: 1,
});

const linesOf = (calls: readonly BreakdownCall[]): string[] => formatCostBreakdown(buildCostBreakdown(calls, {})).split('\n');

describe('the breakdown shows a metered unreported call as unpriced, never as 0 USD', () => {
  it('prints the money line as not complete with the code text and lists the call with its reason', () => {
    const calls = [callOf(1, usage(1000, undefined))];
    const breakdown = buildCostBreakdown(calls, {});
    const lines = formatCostBreakdown(breakdown).split('\n');

    expect(breakdown.cost).toEqual({ amount: null, currency: 'USD', unpricedCalls: 1, unpriced: { cache_read_not_reported: 1 }, priceNotRecordedCalls: 0, legacyPrecisionCalls: 0, priceVersions: [] });
    expect(lines).toContain('cost: not complete: cache reads not reported in 1 call(s)');
    expect(lines).toContain('unpriced: acme/m1 (run run-a, step 1): the upstream did not report the cache reads of the call');
    expect(lines).not.toContain('cost: 0 USD');
  });

  it('keeps a local unreported call priced 0 and out of the unpriced list', () => {
    const breakdown = buildCostBreakdown([callOf(1, usage(1000, undefined), 'local')], {});

    expect(breakdown.cost).toEqual({ amount: 0, currency: 'USD', unpricedCalls: 0, unpriced: {}, priceNotRecordedCalls: 0, legacyPrecisionCalls: 0, priceVersions: [] });
    expect(formatCostBreakdown(breakdown).split('\n')).toContain('cost: 0 USD, all 1 call(s) ran locally and cost nothing');
    expect(breakdown.unpriced).toEqual([]);
    expect(breakdown.cacheReadNotReported).toBe(1);
  });
});

describe('the breakdown split names its call set', () => {
  const mixed = [callOf(1, usage(1000, 500)), callOf(2, usage(1000, undefined)), callOf(3, usage(10, 8, 8))];

  it('keeps the input of every call and splits the input of the D consistent reporting calls', () => {
    const { billed } = buildCostBreakdown(mixed, {});

    expect(billed.inputTokens).toBe(2010);
    expect(billed.reportedInputTokens).toBe(1000);
    expect(billed.uncachedInputTokens).toBe(500);
    expect(billed.cacheReadTokens).toBe(500);
    expect(billed.cacheWriteTokens).toBe(0);
    expect(billed.outputTokens).toBe(30);
    expect(billed.reasoningTokens).toBe(3);
  });

  it('prints the input of all calls, the split over D of N, and the exclusion line', () => {
    const lines = linesOf(mixed);

    expect(lines).toContain('billed tokens: input 2010; output 30 (reasoning 3)');
    expect(lines).toContain('cache split of 1000 input token(s) in 1 of 3 call(s): uncached 500 + cache read 500 + cache write 0');
    expect(lines).toContain('cache reads not reported: 1 of 3 call(s) are left out of the cache split, the cache hit ratio and the cache-miss causes');
    expect(lines.some((line) => line.includes('excluded from the input figures, the cache hit ratio, the cache-miss causes and the cost'))).toBe(false);
  });
});

describe('a breakdown in which no call reported its cache reads', () => {
  const calls = [callOf(1, usage(1000, undefined)), callOf(2, usage(500, undefined))];

  it('holds null for every figure that needs the count, never 0', () => {
    const breakdown = buildCostBreakdown(calls, {});

    expect(breakdown.billed.inputTokens).toBe(1500);
    expect(breakdown.billed.reportedInputTokens).toBeNull();
    expect(breakdown.billed.uncachedInputTokens).toBeNull();
    expect(breakdown.billed.cacheReadTokens).toBeNull();
    expect(breakdown.billed.cacheWriteTokens).toBeNull();
    expect(breakdown.cacheHitRatio).toBeNull();
    expect(breakdown.cacheReadNotReported).toBe(2);
  });

  it('says the split and the hit ratio are not available because the cache reads were not reported', () => {
    const lines = linesOf(calls);

    expect(lines).toContain('cache split: not available (cache reads not reported)');
    expect(lines).toContain('cache hit ratio: none (cache reads not reported)');
    expect(lines).toContain('cost: not complete: cache reads not reported in 2 call(s)');
  });
});

describe('cache-miss causes leave unreported calls out', () => {
  it('counts a reported 0 as a miss and never an unreported call, in any order', () => {
    const calls = [callOf(1, usage(100, undefined)), callOf(2, usage(100, 0)), callOf(3, usage(100, undefined)), callOf(4, usage(100, 50))];

    expect(buildCostBreakdown(calls, {}).cacheMissCauses).toEqual({ unexplained: 1 });
  });
});
