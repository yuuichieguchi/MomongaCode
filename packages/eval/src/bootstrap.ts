import { pickFrom, seededRandom } from './random.ts';

export const BOOTSTRAP_RESAMPLES = 9999;
export const BOOTSTRAP_TAIL_RANK = 250;

export type BootstrapInterval = { mean: number; low: number; high: number; n: number };

const pickRank = (sorted: Float64Array, rank: number): number => {
  const value = sorted[rank - 1];
  if (value === undefined) throw new RangeError(`pairedBootstrap: rank ${rank} is outside ${sorted.length} resamples`);
  return value;
};

export const pairedBootstrap =(differences: readonly number[], options: { seed: number }): BootstrapInterval => {
  const n = differences.length;
  if (n === 0) throw new RangeError('pairedBootstrap: at least one pair is needed');
  const random = seededRandom(options.seed);
  const means = new Float64Array(BOOTSTRAP_RESAMPLES);
  for (let resample = 0; resample < BOOTSTRAP_RESAMPLES; resample += 1) {
    let sum = 0;
    for (let draw = 0; draw < n; draw += 1) sum += pickFrom(random, differences);
    means[resample] = sum / n;
  }
  means.sort();
  const mean = differences.reduce((sum, value) => sum + value, 0) / n;
  return { mean, low: pickRank(means, BOOTSTRAP_TAIL_RANK), high: pickRank(means, BOOTSTRAP_RESAMPLES + 1 - BOOTSTRAP_TAIL_RANK), n };
};
