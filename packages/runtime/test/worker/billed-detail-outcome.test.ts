import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MomongaResponseExtension, Usage } from '@momonga/protocol';
import { billedDetailOf } from '@momonga/runtime';

const USAGE: Usage = { input_tokens: 300, output_tokens: 40, total_tokens: 340, input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 0 } };
const TIMING = { firstEventMs: 10, durationMs: 200 };

const sourceOf = (name: string): string => readFileSync(new URL(`../../src/worker/${name}`, import.meta.url), 'utf8');

describe('billedDetailOf moves the price outcome from a response to a record', () => {
  it('copies unpriced with its code and reason for a plan call, and writes no cost', () => {
    const extension = { unpriced: { code: 'plan', reason: 'plan' } } as unknown as MomongaResponseExtension;

    const detail = billedDetailOf(USAGE, extension, TIMING, 'resp_1');

    expect(detail).toEqual({ responseId: 'resp_1', cachedInputTokens: 100, unpriced: { code: 'plan', reason: 'plan' }, timing: TIMING });
  });

  it('copies cost and writes no unpriced for a priced call', () => {
    const extension = { cost: { amount: 0.5, units: '500000000000000', currency: 'USD', priceVersion: '2026-01-01' } } as unknown as MomongaResponseExtension;

    const detail = billedDetailOf(USAGE, extension, TIMING, 'resp_2');

    expect(detail).toEqual({ responseId: 'resp_2', cachedInputTokens: 100, cost: { amount: 0.5, units: '500000000000000', currency: 'USD', priceVersion: '2026-01-01' }, timing: TIMING });
    expect(billedDetailOf(USAGE, { unpriced: { code: 'no_price_entry', reason: 'no price table' } } as unknown as MomongaResponseExtension, TIMING, 'r')).toHaveProperty('unpriced');
  });
});

describe('a reply whose cost does not match the one ModelCost schema', () => {
  it.each([
    ['without units', { amount: 0.5, currency: 'USD', priceVersion: '2026-01-01' }],
    ['with units that are not a whole number', { amount: 0.5, units: '1.5', currency: 'USD', priceVersion: '2026-01-01' }],
    ['with a negative amount', { amount: -1, units: '5', currency: 'USD', priceVersion: '2026-01-01' }],
  ])('is recorded as unpriced with its reason, %s, and journals no cost', (_shape, cost) => {
    const extension = { cost } as unknown as MomongaResponseExtension;

    const detail = billedDetailOf(USAGE, extension, TIMING, 'resp_3');

    expect(detail).not.toHaveProperty('cost');
    expect(detail.unpriced?.code).toBe('unpriceable_usage');
    expect(detail.unpriced?.reason).toMatch(/^the server replied with a cost that is not a valid price: /);
  });
});

describe('billedDetailOf is the one copier of the price outcome', () => {
  it.each(['model-step.ts', 'context-step.ts'])('%s calls billedDetailOf and copies no cost itself', (name) => {
    const source = sourceOf(name);

    expect(source).toContain('billedDetailOf(');
    expect(source).not.toMatch(/momonga\??\.cost/);
    expect(source).not.toMatch(/momonga\??\.unpriced/);
  });
});
