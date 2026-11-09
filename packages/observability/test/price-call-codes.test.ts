import { describe, expect, it } from 'vitest';
import { UNPRICED_CODES } from '@momonga/protocol';
import { definePriceTable, priceCall } from '@momonga/observability';
import type { CallBilling, CostUsage, PriceTable } from '@momonga/observability';

const AT = new Date(Date.parse('2026-07-10T00:00:00Z'));

const FULL = definePriceTable([
  { provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 1, cachedInputPerMTok: 0.5, cacheWritePerMTok: 2, outputPerMTok: 4, currency: 'USD' },
]);
const BARE = definePriceTable([{ provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 1, outputPerMTok: 4, currency: 'USD' }]);
const EMPTY = definePriceTable([]);

const price = (billing: CallBilling, usage: CostUsage, table: PriceTable, at: Date = AT) => priceCall({ provider: 'acme', model: 'm1', billing, usage, at, table });

describe('priceCall names the cause of an unpriced call with a closed code', () => {
  it('gives the code plan to a plan call, even with a price entry', () => {
    expect(price('plan', { inputTokens: 100, outputTokens: 10 }, FULL)).toMatchObject({ kind: 'unpriced', code: 'plan' });
  });

  it('gives the code unknown_billing to a call whose billing is unknown', () => {
    expect(price('unknown', { inputTokens: 100, outputTokens: 10 }, FULL)).toMatchObject({ kind: 'unpriced', code: 'unknown_billing' });
  });

  it('gives the code cache_read_not_reported to a metered call whose cache-read count is absent', () => {
    expect(price('metered', { inputTokens: 100, outputTokens: 10 }, FULL)).toMatchObject({ kind: 'unpriced', code: 'cache_read_not_reported' });
  });

  it('gives the code no_price_entry to a metered call with no entry', () => {
    expect(price('metered', { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 }, EMPTY)).toMatchObject({ kind: 'unpriced', code: 'no_price_entry' });
  });

  it('gives the code unpriceable_usage to a count that is not a non-negative integer', () => {
    expect(price('metered', { inputTokens: 1.5, outputTokens: 10, cachedInputTokens: 0 }, FULL)).toMatchObject({ kind: 'unpriced', code: 'unpriceable_usage' });
  });

  it('gives the code unpriceable_usage to a call at an invalid time, whether or not the cache-read count is reported', () => {
    expect(price('metered', { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 }, FULL, new Date(Number.NaN))).toMatchObject({ kind: 'unpriced', code: 'unpriceable_usage' });
    expect(price('metered', { inputTokens: 100, outputTokens: 10 }, FULL, new Date(Number.NaN))).toMatchObject({ kind: 'unpriced', code: 'unpriceable_usage' });
  });

  it('gives the code unpriceable_usage to cached input with no cached price', () => {
    expect(price('metered', { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 }, BARE)).toMatchObject({ kind: 'unpriced', code: 'unpriceable_usage' });
  });

  it('gives the code unpriceable_usage to written input with no cache-write price', () => {
    expect(price('metered', { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 40 }, BARE)).toMatchObject({ kind: 'unpriced', code: 'unpriceable_usage' });
  });

  it('keeps the free-text reason beside the code', () => {
    const outcome = price('metered', { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 }, EMPTY);
    expect(outcome).toMatchObject({ kind: 'unpriced', code: 'no_price_entry' });
    expect(typeof (outcome as { reason?: unknown }).reason).toBe('string');
  });
});

describe('every call lands in exactly one class (I-P2)', () => {
  const BILLINGS: readonly CallBilling[] = ['metered', 'local', 'plan', 'unknown'];
  const COUNTS: readonly ('reported' | 'absent')[] = ['reported', 'absent'];
  const OUTCOMES: readonly { usage: CostUsage; table: PriceTable; at: Date }[] = [
    { usage: { inputTokens: 100, outputTokens: 10 }, table: FULL, at: AT },
    { usage: { inputTokens: 100, outputTokens: 10 }, table: EMPTY, at: AT },
    { usage: { inputTokens: 100, outputTokens: 10, cacheWriteInputTokens: 40 }, table: BARE, at: AT },
    { usage: { inputTokens: -1, outputTokens: 10 }, table: FULL, at: AT },
    { usage: { inputTokens: 100, outputTokens: 10 }, table: FULL, at: new Date(Number.NaN) },
  ];
  const withCount = (usage: CostUsage, count: 'reported' | 'absent'): CostUsage => (count === 'reported' ? { ...usage, cachedInputTokens: 0 } : usage);

  const classOf = (outcome: ReturnType<typeof priceCall>): string => {
    const record = outcome as Record<string, unknown>;
    if (outcome.kind === 'priced') {
      expect('code' in record).toBe(false);
      return 'priced';
    }
    expect((UNPRICED_CODES as readonly unknown[]).includes(record['code'])).toBe(true);
    return String(record['code']);
  };

  it('reaches every class of the product of billing, cache-read count and outcome, and no call lands in two or none', () => {
    const reached = new Set<string>();
    for (const billing of BILLINGS) {
      for (const count of COUNTS) for (const entry of OUTCOMES) reached.add(classOf(price(billing, withCount(entry.usage, count), entry.table, entry.at)));
    }
    reached.add(classOf(price('metered', { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 }, BARE)));
    expect([...reached].sort()).toEqual(['priced', ...UNPRICED_CODES].sort());
  });

  it('gives cache_read_not_reported only to a metered call: local, plan and unknown billing keep their class when the count is absent', () => {
    const absent: CostUsage = { inputTokens: 100, outputTokens: 10 };
    expect(classOf(price('metered', absent, FULL))).toBe('cache_read_not_reported');
    expect(classOf(price('local', absent, FULL))).toBe('priced');
    expect(classOf(price('plan', absent, FULL))).toBe('plan');
    expect(classOf(price('unknown', absent, FULL))).toBe('unknown_billing');
  });

  it('classes a local call as priced at nothing, never as unpriced, for any table', () => {
    expect(classOf(price('local', { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 }, EMPTY))).toBe('priced');
    expect(classOf(price('plan', { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 }, EMPTY))).toBe('plan');
  });
});
