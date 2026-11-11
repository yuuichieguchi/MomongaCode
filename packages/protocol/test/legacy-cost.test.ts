import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { RUN_API_SCHEMAS, nanoOfCost, recordedCostOf, unitsOfCost } from '@momonga/protocol';
import { callPriceOf, describeMoney, moneyTallyOf } from '@momonga/observability';

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
const acceptsCharge = ajv.compile(RUN_API_SCHEMAS.RecordContextChargeRequest);
const acceptsEvent = ajv.compile(RUN_API_SCHEMAS.PublicRunEvent);

const LEGACY_STORED = { amount: 17.000000000000004, currency: 'USD', priceVersion: '2026-01-01' } as const;
const EXACT = { amount: 2, units: '2000000000000000', currency: 'USD', priceVersion: '2026-01-01' } as const;

const charged = (cost: unknown) => ({
  id: 1,
  runId: 'run-1',
  sessionId: 'session-1',
  seq: 3,
  step: 1,
  createdAt: 1,
  type: 'usage.charged',
  purpose: 'compaction',
  inputTokens: 5,
  outputTokens: 1,
  totalTokens: 6,
  cost,
});

describe('a cost record written before exact units', () => {
  it('decodes as it was stored, with units null, and an exact record keeps its units', () => {
    expect(recordedCostOf(LEGACY_STORED)).toEqual({ ...LEGACY_STORED, units: null });
    expect(recordedCostOf(EXACT)).toEqual(EXACT);
  });

  it('is read from its decimal amount by the one conversion every figure uses', () => {
    const legacy = recordedCostOf({ amount: 0.0000015004, currency: 'USD', priceVersion: '2026-01-01' });
    expect(unitsOfCost(legacy)).toBe(1_500_400_000n);
    expect(nanoOfCost(legacy)).toBe(1501);
    expect(nanoOfCost(recordedCostOf(EXACT))).toBe(2_000_000_000);
  });

  it('is counted apart, and a total that includes one names the count', () => {
    const line = describeMoney(moneyTallyOf([callPriceOf({ kind: 'priced', cost: recordedCostOf(LEGACY_STORED) }), callPriceOf({ kind: 'priced', cost: recordedCostOf(EXACT) })]));
    expect(moneyTallyOf([callPriceOf({ kind: 'priced', cost: recordedCostOf(LEGACY_STORED) })]).legacyPrecisionCalls).toBe(1);
    expect(line).toContain('includes 1 call(s) recorded before exact units');
    expect(describeMoney(moneyTallyOf([callPriceOf({ kind: 'priced', cost: recordedCostOf(EXACT) })]))).not.toContain('exact units');
  });

  it('is served to a client with units null, and a new record without units is refused by the schema a writer is checked against', () => {
    expect(acceptsEvent(charged(recordedCostOf(LEGACY_STORED))), JSON.stringify(acceptsEvent.errors)).toBe(true);
    const base = { purpose: 'guideline', project: '/work/a', model: 'fm', inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    expect(acceptsCharge({ ...base, detail: { cost: EXACT } })).toBe(true);
    expect(acceptsCharge({ ...base, detail: { cost: LEGACY_STORED } })).toBe(false);
    expect(acceptsCharge({ ...base, detail: { cost: { ...LEGACY_STORED, units: null } } })).toBe(false);
  });
});
