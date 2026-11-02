import { pickFrom, seededRandom } from './random.ts';

export const BOOTSTRAP_RESAMPLES = 9999;
export const BOOTSTRAP_TAIL_RANK = (BOOTSTRAP_RESAMPLES + 1) / 40;

const TAIL_PROBABILITY = BOOTSTRAP_TAIL_RANK / (BOOTSTRAP_RESAMPLES + 1);

const smallestCountWithRealTail = (): number => {
  let count = 1;
  while (count ** -count >= TAIL_PROBABILITY) count += 1;
  return count;
};

export const MINIMUM_PAIRS = smallestCountWithRealTail();

export type BootstrapInterval = { mean: number; low: number; high: number; n: number };

export type Cluster = { numerator: number; denominator: number };

export type ClusterInterval = { value: number; low: number; high: number; clusters: number };

const pickRank = (sorted: Float64Array, rank: number): number => {
  const value = sorted[rank - 1];
  if (value === undefined) throw new RangeError(`bootstrap: rank ${rank} is outside ${sorted.length} resamples`);
  return value;
};

const percentileInterval = (statistics: Float64Array): { low: number; high: number } => {
  statistics.sort();
  return { low: pickRank(statistics, BOOTSTRAP_TAIL_RANK), high: pickRank(statistics, BOOTSTRAP_RESAMPLES + 1 - BOOTSTRAP_TAIL_RANK) };
};

export const pairedBootstrap = (differences: readonly number[], options: { seed: number }): BootstrapInterval => {
  const n = differences.length;
  if (n === 0) throw new RangeError('pairedBootstrap: at least one pair is needed');
  const random = seededRandom(options.seed);
  const means = new Float64Array(BOOTSTRAP_RESAMPLES);
  for (let resample = 0; resample < BOOTSTRAP_RESAMPLES; resample += 1) {
    let sum = 0;
    for (let draw = 0; draw < n; draw += 1) sum += pickFrom(random, differences);
    means[resample] = sum / n;
  }
  const mean = differences.reduce((sum, value) => sum + value, 0) / n;
  return { mean, ...percentileInterval(means), n };
};

export const clusterBootstrap = (clusters: readonly Cluster[], options: { seed: number }): ClusterInterval => {
  if (clusters.length === 0) throw new RangeError('clusterBootstrap: at least one cluster is needed');
  if (clusters.some((cluster) => !(cluster.denominator > 0))) throw new RangeError('clusterBootstrap: every cluster needs a positive denominator');
  const random = seededRandom(options.seed);
  const ratios = new Float64Array(BOOTSTRAP_RESAMPLES);
  for (let resample = 0; resample < BOOTSTRAP_RESAMPLES; resample += 1) {
    let numerator = 0;
    let denominator = 0;
    for (let draw = 0; draw < clusters.length; draw += 1) {
      const cluster = pickFrom(random, clusters);
      numerator += cluster.numerator;
      denominator += cluster.denominator;
    }
    ratios[resample] = numerator / denominator;
  }
  const value = clusters.reduce((sum, cluster) => sum + cluster.numerator, 0) / clusters.reduce((sum, cluster) => sum + cluster.denominator, 0);
  return { value, ...percentileInterval(ratios), clusters: clusters.length };
};
