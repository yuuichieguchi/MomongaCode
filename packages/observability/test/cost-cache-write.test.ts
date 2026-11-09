import { describe, expect, it } from 'vitest';
import { amountOfUnits, definePriceTable, priceCall } from '@momonga/observability';
import type { CostInput, PriceEntry } from '@momonga/observability';

const metered = (input: CostInput) => priceCall({ ...input, billing: 'metered', usageSource: 'reported' });

const CACHING: PriceEntry = {
  provider: 'acme',
  model: 'm1',
  effectiveFrom: '2026-01-01',
  inputPerMTok: 2.5,
  cachedInputPerMTok: 0.25,
  cacheWritePerMTok: 3.125,
  outputPerMTok: 10,
  currency: 'USD',
};

const AT = new Date('2026-06-01T00:00:00Z');

describe('the price of a cache write', () => {
  it('bills uncached input, cache read, cache write and output each at its own rate', () => {
    const table = definePriceTable([CACHING]);
    const priced = metered({ provider: 'acme', model: 'm1', usage: { inputTokens: 1_000_000, cachedInputTokens: 400_000, cacheWriteInputTokens: 100_000, outputTokens: 500_000 }, at: AT, table });
    expect(priced.kind === 'priced' ? { amount: amountOfUnits(priced.units), currency: priced.currency, priceVersion: priced.priceVersion } : priced).toEqual({
      amount: 6.6625,
      currency: 'USD',
      priceVersion: '2026-01-01',
    });
  });

  it('leaves a usage whose cached and written input together exceed the input unpriced, with the reason', () => {
    const table = definePriceTable([CACHING]);
    expect(metered({ provider: 'acme', model: 'm1', usage: { inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 41, outputTokens: 0 }, at: AT, table })).toEqual({
      kind: 'unpriced',
      code: 'unpriceable_usage',
      reason: expect.stringContaining('exceed'),
    });
  });

  it('validates cacheWritePerMTok like the other prices, naming the entry', () => {
    expect(() => definePriceTable([{ ...CACHING, cacheWritePerMTok: -0.5 }])).toThrow(/cacheWritePerMTok.*acme\/m1@2026-01-01|acme\/m1@2026-01-01.*cacheWritePerMTok/);
    expect(() => definePriceTable([{ ...CACHING, cacheWritePerMTok: 0.0000000001 }])).toThrow(/cacheWritePerMTok/);
    expect(() => definePriceTable([{ ...CACHING, cacheWritePerMTok: Number.NaN }])).toThrow(/cacheWritePerMTok/);
  });
});
