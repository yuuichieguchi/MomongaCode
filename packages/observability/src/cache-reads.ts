export type CacheReadUsage = { inputTokens: number; cachedInputTokens?: number; cacheWriteInputTokens: number };

export const isCacheReadReported = <T extends CacheReadUsage>(usage: T): usage is T & { cachedInputTokens: number } => usage.cachedInputTokens !== undefined;

export type CacheReadTally = { calls: number; notReported: number };

export const reportedCallsOf = (tally: CacheReadTally): number => tally.calls - tally.notReported;

export const noCallReported = (tally: CacheReadTally): boolean => tally.calls > 0 && tally.notReported === tally.calls;

export type InputClause = CacheReadTally & { inputTokens: number; cachedInputTokens: number | null };

export type SplitLine = { reportedInputTokens: number; splitCalls: number; calls: number; uncached: number; cacheRead: number; cacheWrite: number };

export const CACHE_READ_TEXT = {
  inputClause: (clause: InputClause): string => {
    if (clause.cachedInputTokens === null) return `${clause.inputTokens} input (cached not reported: cache reads not reported in all ${clause.calls} call(s))`;
    if (clause.notReported === 0) return `${clause.inputTokens} input (${clause.cachedInputTokens} cached)`;
    return `${clause.inputTokens} input (${clause.cachedInputTokens} cached in ${reportedCallsOf(clause)} of ${clause.calls} call(s); cache reads not reported in ${clause.notReported} call(s))`;
  },
  meteredUnpriced: (unpriced: number, calls: number): string =>
    `, ${unpriced} of ${calls} call(s) are metered and did not report cache reads, so their price is unknown and they are not counted in the amount`,
  breakdownExclusion: (notReported: number, calls: number): string =>
    `cache reads not reported: ${notReported} of ${calls} call(s) are left out of the cache split, the cache hit ratio and the cache-miss causes`,
  split: (line: SplitLine): string =>
    `cache split of ${line.reportedInputTokens} input token(s) in ${line.splitCalls} of ${line.calls} call(s): uncached ${line.uncached} + cache read ${line.cacheRead} + cache write ${line.cacheWrite}`,
  splitUnavailable: (causes: { notReported: boolean; inconsistent: boolean }): string =>
    `cache split: not available (${[...(causes.notReported ? ['cache reads not reported'] : []), ...(causes.inconsistent ? ['a call has inconsistent usage'] : [])].join('; ')})`,
  hitRatioNotReported: 'cache hit ratio: none (cache reads not reported)',
} as const;
