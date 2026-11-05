export type Ratio = { readonly num: number; readonly den: number };

export const MARGIN: Ratio = { num: 1, den: 50 };
export const OUTPUT_RESERVE: Ratio = { num: 1, den: 4 };
export const MAX_OUTPUT_WINDOW: Ratio = { num: 1, den: 2 };
export const ESTIMATED_ERROR: Ratio = { num: 3, den: 10 };
export const SUMMARY_WINDOW: Ratio = { num: 6, den: 100 };
export const SUMMARY_ROOM: Ratio = { num: 3, den: 10 };
export const SUMMARY_ACCEPT: Ratio = { num: 13, den: 10 };
export const ITEM_CAP: Ratio = { num: 1, den: 4 };
export const ITEM_ROOM: Ratio = { num: 1, den: 2 };
export const COMPACT_AT: Ratio = { num: 7, den: 10 };
export const EVICT_LOW_WATER: Ratio = { num: 1, den: 2 };
export const COMPACTION_MIN_GAIN: Ratio = { num: 2, den: 1 };

export const MAX_BUDGET_COUNT = 2 ** 33;

export const ERROR_WINDOW = 20;
export const RATIO_QUANTUM = 2 ** 20;

const assertInDomain = (x: number): void => {
  if (!Number.isInteger(x) || Math.abs(x) > MAX_BUDGET_COUNT) {
    throw new RangeError(`budget count ${x} is not an integer within ±2^33`);
  }
};

const floorQuotient = (numerator: number, denominator: number): number => {
  if (Math.abs(numerator) > Number.MAX_SAFE_INTEGER) {
    const top = BigInt(numerator);
    const bottom = BigInt(denominator);
    const quotient = top / bottom;
    return Number(top % bottom < 0n ? quotient - 1n : quotient);
  }
  const remainder = ((numerator % denominator) + denominator) % denominator;
  return (numerator - remainder) / denominator;
};

export const floorRatio = (ratio: Ratio, x: number): number => {
  assertInDomain(x);
  return floorQuotient(ratio.num * x, ratio.den);
};

export const ceilRatio = (ratio: Ratio, x: number): number => {
  assertInDomain(x);
  return -floorQuotient(-ratio.num * x, ratio.den);
};

export const quantizedRatioOf = (value: number): Ratio => ({ num: Math.ceil(value * RATIO_QUANTUM), den: RATIO_QUANTUM });
