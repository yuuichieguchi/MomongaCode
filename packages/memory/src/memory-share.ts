export const CONTRIBUTION_WINDOW_RUNS = 20;
export const DEFAULT_MEMORY_SHARE = 1 / 4;
export const MIN_MEMORY_SHARE = 1 / 16;
export const MAX_MEMORY_SHARE = 1 / 2;
export const SHARE_FACTOR = 2;

const LOW_USE_DENOMINATOR = 4;
const HIGH_USE_NUMERATOR = 3;

export type ContributionWindowRun = { injected: number; used: number; memoriesDropped: boolean };

export const nextMemoryShare = ({ previous = DEFAULT_MEMORY_SHARE, runs }: { previous: number | undefined; runs: readonly ContributionWindowRun[] }): number => {
  if (runs.length < CONTRIBUTION_WINDOW_RUNS) return previous;
  const window = runs.slice(0, CONTRIBUTION_WINDOW_RUNS);
  const injected = window.reduce((sum, run) => sum + run.injected, 0);
  const used = window.reduce((sum, run) => sum + run.used, 0);
  if (injected === 0) return previous;
  if (used * LOW_USE_DENOMINATOR < injected) return Math.max(MIN_MEMORY_SHARE, previous / SHARE_FACTOR);
  if (used * LOW_USE_DENOMINATOR > injected * HIGH_USE_NUMERATOR && window.some((run) => run.memoriesDropped)) {
    return Math.min(MAX_MEMORY_SHARE, previous * SHARE_FACTOR);
  }
  return previous;
};
