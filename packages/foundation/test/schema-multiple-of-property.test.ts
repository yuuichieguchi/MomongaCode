import { describe, expect, it } from 'vitest';
import { clearUntrustedSchemaCaches, validateUntrusted } from '@momonga/foundation';
import { seededRandom, type Random } from './seeded-random.ts';

type Decimal = { readonly coefficient: bigint; readonly exponent: number };

const exactDecimal = (value: number): Decimal => {
  const text = value.toString();
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(text);
  if (match === null) throw new Error(`not a finite decimal: ${text}`);
  const [, sign, whole, fraction = '', power = '0'] = match;
  const coefficient = BigInt(`${sign}${whole}${fraction}`);
  return { coefficient, exponent: Number(power) - fraction.length };
};

const scaled = (decimal: Decimal, exponent: number): bigint => decimal.coefficient * 10n ** BigInt(decimal.exponent - exponent);

const isExactMultiple = (instance: number, divisor: number): boolean => {
  const a = exactDecimal(instance);
  const b = exactDecimal(divisor);
  const common = Math.min(a.exponent, b.exponent);
  return scaled(a, common) % scaled(b, common) === 0n;
};

describe('the exact decimal oracle itself', () => {
  it.each([
    [1e20, 3, false],
    [1e308, 0.5, true],
    [0.0075, 0.0001, true],
    [0.3, 0.1, true],
    [7, 2, false],
    [-4.5, 1.5, true],
    [0, 0.7, true],
    [1.5e-7, 5e-8, true],
    [1e21, 7, false],
  ])('%s multipleOf %s is %s', (instance, divisor, expected) => {
    expect(isExactMultiple(instance, divisor)).toBe(expected);
  });
});

const digits = (random: Random, count: number): string => {
  let text = String(random.int(1, 9));
  for (let index = 1; index < count; index += 1) text += String(random.int(0, 9));
  return text;
};

const largeInteger = (random: Random): number => {
  for (;;) {
    const value = Number(`${digits(random, random.int(1, 15))}e${random.int(0, 300)}`);
    if (Number.isFinite(value) && value <= Number.MAX_VALUE) return value;
  }
};

const shortDecimal = (random: Random): number => Number(`${digits(random, random.int(1, 15))}e${random.int(-20, 5)}`);

const smallDivisor = (random: Random): number => Number(`${digits(random, random.int(1, 3))}e${random.int(-6, 2)}`);

const anyNumber = (random: Random): number => (random.next() < 0.5 ? largeInteger(random) : shortDecimal(random));

const signed = (random: Random, value: number): number => (random.next() < 0.25 ? -value : value);

const multipleOfDivisor = (random: Random, divisor: number): number => {
  const b = exactDecimal(divisor);
  for (;;) {
    const quotient = BigInt(digits(random, random.int(1, 12)));
    const value = Number(`${b.coefficient * quotient}e${b.exponent}`);
    if (Number.isFinite(value) && value !== 0) return value;
  }
};

type Case = { instance: number; divisor: number };

const cases = (seed: number, count: number): Case[] => {
  const random = seededRandom(seed);
  const generated: Case[] = [];
  for (let index = 0; index < count; index += 1) {
    const divisor = random.next() < 0.5 ? smallDivisor(random) : anyNumber(random);
    const instance = random.next() < 0.5 ? multipleOfDivisor(random, divisor) : anyNumber(random);
    generated.push({ instance: signed(random, instance), divisor });
  }
  return generated;
};

const SEEDS = [1, 20261106, 0x5eed];
const CASES_PER_SEED = 400;

describe('multipleOf through the untrusted-schema boundary equals the exact decimal quotient rule', () => {
  it.each(SEEDS)('seed %i: every verdict equals the exact decimal oracle', (seed) => {
    clearUntrustedSchemaCaches();
    const generated = cases(seed, CASES_PER_SEED);
    const mismatches = generated
      .map(({ instance, divisor }) => ({
        instance: instance.toString(),
        divisor: divisor.toString(),
        expected: isExactMultiple(instance, divisor),
        actual: validateUntrusted('multiple-of-property', { multipleOf: divisor }, instance).valid,
      }))
      .filter((entry) => entry.expected !== entry.actual);
    expect(generated.filter(({ instance, divisor }) => isExactMultiple(instance, divisor)).length).toBeGreaterThan(CASES_PER_SEED / 4);
    expect(mismatches).toEqual([]);
  });

  it.each([
    [1e20, 3, false],
    [1e308, 0.5, true],
    [0.0075, 0.0001, true],
    [Number.MAX_VALUE, 1, true],
    [Number.MAX_VALUE, Number.MAX_VALUE, true],
    [Number.MAX_VALUE, 3, false],
    [5e-324, 5e-324, true],
  ])('%s multipleOf %s is valid=%s', (instance, divisor, expected) => {
    clearUntrustedSchemaCaches();
    expect(validateUntrusted('multiple-of-fixed', { multipleOf: divisor }, instance).valid).toBe(expected);
  });
});
