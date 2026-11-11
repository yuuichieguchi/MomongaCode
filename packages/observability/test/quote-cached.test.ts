import { describe, expect, it } from 'vitest';
import { definePriceTable, priceCall, quoteChain } from '@momonga/observability';

const table = definePriceTable([
  { provider: 'p', model: 'dear-cache', effectiveFrom: '2026-01-01', inputPerMTok: 1, cachedInputPerMTok: 8, cacheWritePerMTok: 2, outputPerMTok: 3, currency: 'USD' },
  { provider: 'p', model: 'plain', effectiveFrom: '2026-01-01', inputPerMTok: 5, cachedInputPerMTok: 0.5, outputPerMTok: 3, currency: 'USD' },
]);
const at = new Date('2026-06-01T00:00:00Z');

const quoted = (model: string): { inUnits: bigint; outUnits: bigint } => {
  const quote = quoteChain('m', [{ billing: 'metered', provider: 'p', model }], table, at.getTime());
  if (!quote.priced) throw new Error(`the chain of ${model} is not priced`);
  return { inUnits: BigInt(quote.inUnits), outUnits: BigInt(quote.outUnits) };
};

const charged = (model: string, usage: { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number }): bigint => {
  const price = priceCall({ provider: 'p', model, billing: 'metered', usageSource: 'reported', usage, at, table });
  if (price.kind !== 'priced') throw new Error(`the call is not priced: ${price.reason}`);
  return price.units;
};

describe('the quote of a model bounds every price the charge can use', () => {
  it('takes the cached input price when it is above the input and the cache write prices', () => {
    expect(quoted('dear-cache').inUnits).toBe(8n * quoted('plain').inUnits / 5n);
  });

  it.each([
    { inputTokens: 1000, cachedInputTokens: 1000, cacheWriteInputTokens: 0, outputTokens: 10 },
    { inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 300, outputTokens: 10 },
    { inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 1000, outputTokens: 0 },
  ])('reserves at least the charge of a call with usage %j', (usage) => {
    const quote = quoted('dear-cache');
    const reservation = BigInt(usage.inputTokens) * quote.inUnits + BigInt(usage.outputTokens) * quote.outUnits;
    expect(reservation >= charged('dear-cache', usage)).toBe(true);
  });

  it('keeps the input price as the bound when the cached price is below it', () => {
    const quote = quoted('plain');
    const usage = { inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0 };
    expect(BigInt(usage.inputTokens) * quote.inUnits).toBe(charged('plain', usage));
  });
});
