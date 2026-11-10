import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { RUN_API_SCHEMAS, UNPRICED_CODES } from '@momonga/protocol';

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
addFormats.default(ajv);
const acceptsEvent = ajv.compile(RUN_API_SCHEMAS.PublicRunEvent);

const ENVELOPE = { id: 7, runId: 'r1', sessionId: 's1', seq: 4, step: 1, createdAt: 1_800_000_000_000 };
const CHARGED = { ...ENVELOPE, type: 'usage.charged', purpose: 'compaction', inputTokens: 5, outputTokens: 1, totalTokens: 6 };
const COST = { amount: 0.25, currency: 'USD', priceVersion: '2026-01-01' };
const OLD_LINE =
  '{"id":7,"runId":"r1","sessionId":"s1","seq":4,"step":1,"createdAt":1800000000000,"type":"usage.charged","purpose":"compaction","inputTokens":5,"outputTokens":1,"totalTokens":6,"cost":{"amount":0.25,"currency":"USD","priceVersion":"2026-01-01"}}';

describe('the closed list of unpriced codes', () => {
  it('is plan, unknown_billing, usage_not_reported, cache_read_not_reported, no_price_entry and unpriceable_usage, in that order', () => {
    expect(UNPRICED_CODES).toEqual(['plan', 'unknown_billing', 'usage_not_reported', 'cache_read_not_reported', 'no_price_entry', 'unpriceable_usage']);
  });
});

describe('usage.charged carries the price outcome', () => {
  it.each(['plan', 'unknown_billing', 'usage_not_reported', 'cache_read_not_reported', 'no_price_entry', 'unpriceable_usage'])('accepts unpriced with the code %s', (code) => {
    expect(acceptsEvent({ ...CHARGED, unpriced: { code, reason: 'why' } })).toBe(true);
  });

  it('refuses a code outside the list once the listed codes are accepted', () => {
    expect(acceptsEvent({ ...CHARGED, unpriced: { code: 'plan', reason: 'plan' } })).toBe(true);
    expect(acceptsEvent({ ...CHARGED, unpriced: { code: 'free', reason: 'why' } })).toBe(false);
  });

  it('refuses unpriced without its reason once a complete outcome is accepted', () => {
    expect(acceptsEvent({ ...CHARGED, unpriced: { code: 'plan', reason: 'plan' } })).toBe(true);
    expect(acceptsEvent({ ...CHARGED, unpriced: { code: 'plan' } })).toBe(false);
  });

  it('refuses a record with both cost and unpriced, while each alone is accepted', () => {
    expect(acceptsEvent({ ...CHARGED, unpriced: { code: 'no_price_entry', reason: 'no price entry' } })).toBe(true);
    expect(acceptsEvent({ ...CHARGED, cost: COST })).toBe(true);
    expect(acceptsEvent({ ...CHARGED, cost: COST, unpriced: { code: 'no_price_entry', reason: 'no price entry' } })).toBe(false);
  });

  it('decodes an old journal line with neither field or with cost only, beside a line written after the change', () => {
    expect(acceptsEvent({ ...CHARGED, unpriced: { code: 'unknown_billing', reason: 'the billing of the target is unknown' } })).toBe(true);
    expect(acceptsEvent(CHARGED)).toBe(true);
    expect(acceptsEvent(JSON.parse(OLD_LINE))).toBe(true);
  });

  it('round-trips a usage.charged journaled from an estimated usage with the code usage_not_reported', () => {
    const line = JSON.stringify({ ...CHARGED, unpriced: { code: 'usage_not_reported', reason: 'the upstream reported no usage' } });

    expect(acceptsEvent(JSON.parse(line))).toBe(true);
    expect(JSON.parse(line).unpriced).toEqual({ code: 'usage_not_reported', reason: 'the upstream reported no usage' });
  });
});
