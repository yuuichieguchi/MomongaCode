const WILSON_Z_95 = 1.959963984540054;

export type WilsonInterval = { low: number; high: number };

export const wilsonInterval = (k: number, n: number): WilsonInterval => {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n <= 0 || k > n) {
    throw new RangeError(`wilsonInterval: ${k} of ${n} is not a proportion`);
  }
  const rate = k / n;
  const z2 = WILSON_Z_95 ** 2;
  const denominator = 1 + z2 / n;
  const center = (rate + z2 / (2 * n)) / denominator;
  const margin = (WILSON_Z_95 * Math.sqrt((rate * (1 - rate)) / n + z2 / (4 * n ** 2))) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
};
