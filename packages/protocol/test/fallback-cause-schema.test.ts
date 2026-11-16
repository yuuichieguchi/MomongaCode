import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { RUN_API_SCHEMAS, fallbackCauseName, isFallbackCause, isFallbackCauseList } from '../src/index.ts';

type SchemaNode = { properties: Record<string, SchemaNode>; items: SchemaNode };

const costReport = (RUN_API_SCHEMAS as unknown as Record<string, SchemaNode>)['CostReport'] as SchemaNode;
const causeSchema = costReport.properties['runs']!.items.properties['fallbacks']!.items.properties['failed']!.items;

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
const schemaAccepts = ajv.compile(causeSchema as unknown as Record<string, unknown>);
const accepts = (value: unknown): boolean => schemaAccepts(value) === true;

const ALLOWED = { target: 'plan', code: 'plan_usage_unavailable', message: 'Try again later.', fromBilling: 'plan', toBilling: 'metered', reason: 'billing_change_allowed' };
const REFUSED = {
  target: 'metered',
  code: 'billing_change_refused',
  message: 'changing from plan to metered billing is not allowed (models.billingChanges)',
  fromBilling: 'plan',
  toBilling: 'metered',
  reason: 'billing_change_refused',
};
const PLAIN = { target: 'plan', code: null, message: 'Try again later.' };
const ONLY_FROM = { ...PLAIN, fromBilling: 'plan' };
const FROM_AND_TO = { ...PLAIN, fromBilling: 'plan', toBilling: 'metered' };
const ONLY_REASON = { ...PLAIN, reason: 'billing_change_allowed' };
const OTHER_REASON = { ...ALLOWED, reason: 'other' };
const FREE_BILLING = { ...ALLOWED, toBilling: 'free' };
const EXTRA_KEY = { ...PLAIN, x: 1 };
const { code: _missing, ...CODE_MISSING } = PLAIN;

describe('the fallback cause schema accepts every cause the gateway writes', () => {
  it('accepts an allowed billing change', () => {
    expect(accepts(ALLOWED)).toBe(true);
  });

  it('accepts a refused billing change', () => {
    expect(accepts(REFUSED)).toBe(true);
  });

  it('refuses a record with one or two of the three billing fields', () => {
    expect([ONLY_FROM, FROM_AND_TO, ONLY_REASON].map(accepts)).toEqual([false, false, false]);
  });

  it('refuses a reason or a billing kind outside the lists', () => {
    expect([OTHER_REASON, FREE_BILLING].map(accepts)).toEqual([false, false]);
  });

  it('the guard and the schema agree on every sample', () => {
    const samples = [ALLOWED, REFUSED, ONLY_FROM, FROM_AND_TO, ONLY_REASON, OTHER_REASON, FREE_BILLING, PLAIN, EXTRA_KEY, CODE_MISSING];
    expect(samples.map((sample) => isFallbackCause(sample))).toEqual(samples.map(accepts));
    expect(samples.map((sample) => isFallbackCause(sample))).toEqual([true, true, false, false, false, false, false, true, false, false]);
  });

  it('isFallbackCauseList is false for a non-array and for a list holding one bad member', () => {
    expect(isFallbackCauseList(ALLOWED)).toBe(false);
    expect(isFallbackCauseList([ALLOWED, ONLY_FROM])).toBe(false);
    expect(isFallbackCauseList([ALLOWED, PLAIN])).toBe(true);
  });
});

describe('FallbackCause.name: the canonical model name a cause carries beside its target', () => {
  const NAMED = { ...PLAIN, name: 'chatgpt/gpt-5.5' };

  it('the schema and the guard accept a string name and refuse any other type', () => {
    const samples = [NAMED, { ...PLAIN, name: 7 }, { ...PLAIN, name: null }];
    expect(samples.map(accepts)).toEqual([true, false, false]);
    expect(samples.map((sample) => isFallbackCause(sample))).toEqual([true, false, false]);
  });

  it('the name of a cause is its canonical name when present and its target otherwise', () => {
    expect(fallbackCauseName(NAMED)).toBe('chatgpt/gpt-5.5');
    expect(fallbackCauseName(PLAIN)).toBe('plan');
  });
});
