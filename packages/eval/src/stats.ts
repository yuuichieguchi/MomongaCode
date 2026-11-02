export const WILSON_Z_95 = 1.959963984540054;

export type Proportion = { successes: number; trials: number; rate: number; low: number; high: number };

export const proportionOf = (successes: number, trials: number): Proportion => {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || successes < 0 || trials < 0 || successes > trials) {
    throw new RangeError(`proportionOf: ${successes} successes of ${trials} trials is not a proportion`);
  }
  if (trials === 0) throw new RangeError('proportionOf: a proportion needs at least one trial');
  const rate = successes / trials;
  const z2 = WILSON_Z_95 ** 2;
  const denominator = 1 + z2 / trials;
  const center = (rate + z2 / (2 * trials)) / denominator;
  const margin = (WILSON_Z_95 * Math.sqrt((rate * (1 - rate)) / trials + z2 / (4 * trials ** 2))) / denominator;
  return { successes, trials, rate, low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
};
