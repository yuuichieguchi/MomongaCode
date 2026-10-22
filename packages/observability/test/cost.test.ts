import { describe, expect, it } from 'vitest';
import { PRICE_TABLE, computeCost, definePriceTable } from '@momonga/observability';
import type { PriceEntry } from '@momonga/observability';

const ENTRIES: PriceEntry[] = [
  { provider: 'acme', model: 'm1', effectiveFrom: '2025-01-01', inputPerMTok: 2.5, cachedInputPerMTok: 0.25, outputPerMTok: 10, currency: 'USD' },
  { provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 1.25, outputPerMTok: 5, currency: 'USD' },
  { provider: 'acme', model: 'm2', effectiveFrom: '2025-06-01', inputPerMTok: 0.5, outputPerMTok: 1.5, currency: 'USD' },
  { provider: 'acme', model: 'm3', effectiveFrom: '2025-01-01', inputPerMTok: 0.1, outputPerMTok: 0.2, currency: 'USD' },
];

const table = definePriceTable(ENTRIES);

const cost = (model: string, at: string, usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }) =>
  computeCost({ provider: 'acme', model, usage, at: new Date(at), table });

describe('computeCost', () => {
  it('prices cached input as a subset of input at the cached rate', () => {
    expect(cost('m1', '2025-06-15T00:00:00Z', { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 500_000 })).toEqual({
      amount: 6.6,
      currency: 'USD',
      priceVersion: '2025-01-01',
    });
  });

  it('switches to the newer entry exactly at its effectiveFrom (UTC) and prices cached tokens at the input rate when no cached rate exists', () => {
    const usage = { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 500_000 };
    expect(cost('m1', '2025-12-31T23:59:59.999Z', usage)).toEqual({ amount: 6.6, currency: 'USD', priceVersion: '2025-01-01' });
    expect(cost('m1', '2026-01-01T00:00:00Z', usage)).toEqual({ amount: 3.75, currency: 'USD', priceVersion: '2026-01-01' });
  });

  it('treats absent cachedInputTokens as zero', () => {
    expect(cost('m1', '2025-03-01T00:00:00Z', { inputTokens: 100_000, outputTokens: 100_000 })?.amount).toBe(1.25);
  });

  it('uses exact decimal arithmetic', () => {
    expect(cost('m2', '2025-07-01T00:00:00Z', { inputTokens: 3, outputTokens: 7 })?.amount).toBe(0.000012);
    expect(cost('m3', '2025-07-01T00:00:00Z', { inputTokens: 1_000_000, outputTokens: 1_000_000 })?.amount).toBe(0.3);
  });

  it('returns null for unknown models, unknown providers and dates before the first entry', () => {
    expect(cost('nope', '2025-07-01T00:00:00Z', { inputTokens: 1, outputTokens: 1 })).toBeNull();
    expect(
      computeCost({ provider: 'other', model: 'm1', usage: { inputTokens: 1, outputTokens: 1 }, at: new Date('2025-07-01T00:00:00Z'), table }),
    ).toBeNull();
    expect(cost('m2', '2025-05-31T23:59:59.999Z', { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });

  it('rejects cachedInputTokens greater than inputTokens', () => {
    expect(() => cost('m1', '2025-07-01T00:00:00Z', { inputTokens: 10, cachedInputTokens: 11, outputTokens: 0 })).toThrow(RangeError);
  });

  it('prices the on-device Apple model at zero with the default table', () => {
    const result = computeCost({
      provider: 'apple',
      model: 'system',
      usage: { inputTokens: 123_456, outputTokens: 7_890 },
      at: new Date('2026-10-23T00:00:00Z'),
    });
    expect(result).toMatchObject({ amount: 0, currency: 'USD' });
    expect(typeof result?.priceVersion).toBe('string');
    expect(PRICE_TABLE.some((entry) => entry.provider === 'apple' && entry.model === 'system')).toBe(true);
  });
});

describe('definePriceTable', () => {
  it('accepts the built-in table', () => {
    expect(() => definePriceTable([...PRICE_TABLE])).not.toThrow();
  });

  it('rejects duplicate (provider, model, effectiveFrom) naming the entry', () => {
    expect(() => definePriceTable([...ENTRIES, { ...ENTRIES[1]!, inputPerMTok: 9 }])).toThrow(/acme\/m1@2026-01-01/);
  });

  it('rejects a currency other than USD naming the entry', () => {
    const euro = { ...ENTRIES[0]!, currency: 'EUR' } as unknown as PriceEntry;
    expect(() => definePriceTable([euro])).toThrow(/acme\/m1@2025-01-01/);
  });

  it('rejects negative prices naming the entry', () => {
    expect(() => definePriceTable([...ENTRIES.slice(0, 2), { ...ENTRIES[2]!, outputPerMTok: -1 }])).toThrow(/acme\/m2@2025-06-01/);
    expect(() => definePriceTable([{ ...ENTRIES[0]!, cachedInputPerMTok: -0.5 }])).toThrow(/acme\/m1@2025-01-01/);
  });
});
