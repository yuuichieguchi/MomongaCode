import { describe, expect, it, vi } from 'vitest';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import { admitRequest, composeBudget, nanoOfAmount, nanoOfCost, nanoOfDecimal, nanoOfUnits, usdOfNano } from '@momonga/protocol';
import type { AdmissionAsk, TreeSpend } from '@momonga/protocol';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const seeded = (seed: number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const NOTHING: TreeSpend = { totalTokens: 0, costNano: 0, unpricedCalls: 0, reservedTokens: 0, reservedNano: 0 };

describe('the money meter counts in whole nano-USD, rounded up', () => {
  it('charges 1 nano for an amount below one nano, and the exact count for a whole number of nano', () => {
    expect(nanoOfAmount(1e-12)).toBe(1);
    expect(nanoOfAmount(0)).toBe(0);
    expect(nanoOfAmount(0.000000001)).toBe(1);
    expect(nanoOfAmount(1.5)).toBe(1_500_000_000);
    expect(nanoOfAmount(9)).toBe(9_000_000_000);
    expect(nanoOfAmount(12)).toBe(12_000_000_000);
    expect(nanoOfAmount(9.1)).toBe(9_100_000_000);
    expect(nanoOfAmount(1_000_000)).toBe(1_000_000_000_000_000);
    expect(nanoOfAmount(0.0000000011)).toBe(2);
  });

  it('counts a generated amount of whole nano exactly, at every size up to the largest limit', () => {
    const random = seeded(20261111);
    for (let round = 0; round < 20_000; round += 1) {
      const whole = BigInt(Math.floor(random() * 10 ** Math.floor(random() * 7)));
      const nano = BigInt(Math.floor(random() * 1_000_000_000));
      const text = `${whole}.${nano.toString().padStart(9, '0')}`;
      const exact = Number(whole * 1_000_000_000n + nano);
      expect(nanoOfDecimal(text), text).toBe(exact);
      expect(nanoOfAmount(Number(text)), text).toBe(exact);
    }
  });

  it('never counts a generated decimal text below its exact value, and less than one nano above it', () => {
    const random = seeded(7);
    for (let round = 0; round < 20_000; round += 1) {
      const whole = BigInt(Math.floor(random() * 1_000_000));
      const fractionDigits = Math.floor(random() * 16);
      const fraction = Array.from({ length: fractionDigits }, () => String(Math.floor(random() * 10))).join('');
      const text = fraction === '' ? String(whole) : `${whole}.${fraction}`;
      const exactUnits = BigInt(`${whole}${fraction.padEnd(15, '0')}`);
      const counted = BigInt(nanoOfDecimal(text)) * 1_000_000n;
      expect(counted >= exactUnits, text).toBe(true);
      expect(counted < exactUnits + 1_000_000n, text).toBe(true);
      expect(nanoOfUnits(exactUnits.toString()), text).toBe(nanoOfDecimal(text));
    }
  });

  it('reads the exponent form a number prints in', () => {
    expect(nanoOfDecimal('1e-7')).toBe(100);
    expect(nanoOfDecimal('1.5e-7')).toBe(150);
    expect(nanoOfDecimal('2.5e+3')).toBe(2_500_000_000_000);
    expect(() => nanoOfDecimal('1e+300')).toThrow(RangeError);
    expect(() => nanoOfDecimal('-1')).toThrow(RangeError);
    expect(() => nanoOfDecimal('1,5')).toThrow(RangeError);
  });

  it('counts a cost from its exact price units when the record carries them, and from the decimal text of the amount otherwise', () => {
    expect(nanoOfCost({ amount: 17, units: '17000000000000001' })).toBe(17_000_000_001);
    expect(nanoOfCost({ amount: 17, units: null })).toBe(17_000_000_000);
    expect(() => nanoOfUnits('1.5')).toThrow(RangeError);
  });

  it('keeps the sum of a thousand charges at or above the exact sum', () => {
    const charges = Array.from({ length: 1000 }, () => 1e-12);
    expect(charges.map(nanoOfAmount).reduce((sum, nano) => sum + nano, 0)).toBeGreaterThanOrEqual(1);
    expect(charges.map(nanoOfAmount).reduce((sum, nano) => sum + nano, 0)).toBe(1000);
  });

  it('refuses a negative or non-finite amount', () => {
    expect(() => nanoOfAmount(-1)).toThrow(RangeError);
    expect(() => nanoOfAmount(Number.NaN)).toThrow(RangeError);
  });

  it('writes nano as a decimal number of dollars', () => {
    expect(usdOfNano(1_500_000_000)).toBe('1.5');
    expect(usdOfNano(1)).toBe('0.000000001');
    expect(usdOfNano(2_000_000_000)).toBe('2');
  });
});

describe('admission of one model request against the budget of the run tree', () => {
  const ask = (over: Partial<AdmissionAsk>): AdmissionAsk => ({ inputUpper: 1000, outputWanted: 4000, outputFloor: 256, limits: {}, ...over });

  it('admits with the wanted output when no limit is declared, reserving input plus output tokens', () => {
    expect(admitRequest(ask({}), NOTHING)).toEqual({ kind: 'admitted', maxOutputTokens: 4000, reservedTokens: 5000, reservedNano: 0 });
  });

  it('shrinks the output cap to what the token limit leaves', () => {
    expect(admitRequest(ask({ limits: { tokens: 3000 } }), NOTHING)).toEqual({ kind: 'admitted', maxOutputTokens: 2000, reservedTokens: 3000, reservedNano: 0 });
  });

  it('refuses when the cap would fall below the floor, naming cap_too_small, and limit when nothing is left', () => {
    expect(admitRequest(ask({ limits: { tokens: 1200 } }), NOTHING)).toEqual({ kind: 'refused', dimension: 'tokens', cause: 'cap_too_small', spent: 0, limit: 1200, admitsAt: 1256 });
    expect(admitRequest(ask({ limits: { tokens: 1200 } }), { ...NOTHING, totalTokens: 1200 })).toEqual({ kind: 'refused', dimension: 'tokens', cause: 'limit', spent: 1200, limit: 1200 });
  });

  it('counts the reservations of the other runs of the tree as spent', () => {
    expect(admitRequest(ask({ limits: { tokens: 6000 } }), { ...NOTHING, totalTokens: 1000, reservedTokens: 3000 })).toEqual({ kind: 'admitted', maxOutputTokens: 1000, reservedTokens: 2000, reservedNano: 0 });
  });

  it('caps the output by money: floor((available - input * pIn) / pOut), and one more token would not fit', () => {
    const price = { inUnits: 3_000_000n, outUnits: 15_000_000n };
    const admitted = admitRequest(ask({ price, limits: { costNano: 20_000 } }), NOTHING);
    expect(admitted).toEqual({ kind: 'admitted', maxOutputTokens: 1133, reservedTokens: 2133, reservedNano: 19_995 });
    expect(1000 * 3 + 1133 * 15).toBeLessThanOrEqual(20_000);
    expect(1000 * 3 + 1134 * 15).toBeGreaterThan(20_000);
  });

  it('refuses a priced request that does not fit the money left, and an unpriced one whenever a money limit is declared', () => {
    const price = { inUnits: 3_000_000n, outUnits: 15_000_000n };
    expect(admitRequest(ask({ price, limits: { costNano: 5_000 } }), NOTHING)).toEqual({ kind: 'refused', dimension: 'cost', cause: 'cap_too_small', spent: 0, limit: 5_000, admitsAt: 6_840 });
    expect(admitRequest(ask({ price, limits: { costNano: 5_000 } }), { ...NOTHING, costNano: 4_000, reservedNano: 1_000 })).toEqual({ kind: 'refused', dimension: 'cost', cause: 'limit', spent: 5_000, limit: 5_000 });
    expect(admitRequest(ask({ limits: { costNano: 5_000 } }), NOTHING)).toEqual({ kind: 'refused', dimension: 'cost', cause: 'unpriced', spent: 0, limit: 5_000 });
  });

  it('admits a local target, priced at zero, under any money limit', () => {
    expect(admitRequest(ask({ price: { inUnits: 0n, outUnits: 0n }, limits: { costNano: 1 } }), NOTHING)).toEqual({ kind: 'admitted', maxOutputTokens: 4000, reservedTokens: 5000, reservedNano: 0 });
  });

  it('never reserves more than the limit leaves, for any ask (the ceiling)', () => {
    const sizes = [0, 1, 255, 256, 257, 5_000, 200_000];
    const prices = [0n, 1n, 150_000n, 3_000_000n, 75_000_000_000n];
    for (const inputUpper of sizes) {
      for (const outputWanted of [1, 256, 4_000, 64_000]) {
        for (const tokens of [0, 300, 6_000, 2_000_000]) {
          for (const costNano of [0, 1, 20_000, 10_000_000_000]) {
            for (const inUnits of prices) {
              for (const outUnits of prices) {
                for (const spent of [0, 250, 5_999]) {
                  const verdict = admitRequest({ inputUpper, outputWanted, outputFloor: 256, price: { inUnits, outUnits }, limits: { tokens, costNano } }, { ...NOTHING, totalTokens: spent, costNano: spent });
                  if (verdict.kind === 'refused') continue;
                  expect(spent + verdict.reservedTokens).toBeLessThanOrEqual(tokens);
                  expect(spent + verdict.reservedNano).toBeLessThanOrEqual(costNano);
                  expect(verdict.maxOutputTokens).toBeGreaterThanOrEqual(Math.min(256, outputWanted));
                  expect(BigInt(inputUpper) * inUnits + BigInt(verdict.maxOutputTokens) * outUnits).toBeLessThanOrEqual(BigInt(costNano - spent) * 1_000_000n);
                }
              }
            }
          }
        }
      }
    }
  });
});

describe('a mandate budget under the ceilings of the user', () => {
  it('takes the smaller of the two per dimension, and the declared value where no ceiling is set', () => {
    expect(composeBudget({ tokens: 500, costUsd: 5, timeMs: 1000, steps: 9, retries: 2 }, { tokens: 300, costUsd: 9 })).toEqual({ steps: 9, tokens: 300, costUsd: 5, timeMs: 1000, retries: 2 });
    expect(composeBudget({}, { costUsd: 2 })).toEqual({ costUsd: 2 });
  });
});
