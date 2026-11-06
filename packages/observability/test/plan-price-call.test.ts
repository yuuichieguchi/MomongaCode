import { describe, expect, it } from 'vitest';
import { definePriceTable, priceCall } from '@momonga/observability';

describe('priceCall on a plan target', () => {
  it('never gives a plan call a money price, even when the price table holds an entry for the model', () => {
    const table = definePriceTable([{ provider: 'chatgpt', model: 'gpt-fake', effectiveFrom: '2026-01-01', inputPerMTok: 1, outputPerMTok: 2, currency: 'USD' }]);
    expect(priceCall({ provider: 'chatgpt', model: 'gpt-fake', usage: { inputTokens: 1000, outputTokens: 1000 }, at: new Date('2026-10-23T00:00:00Z'), table, billing: 'plan' })).toEqual({
      kind: 'unpriced',
      reason: 'plan',
    });
  });
});
