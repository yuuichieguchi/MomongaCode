import { CACHE_READS_NOT_REPORTED } from '@momonga/protocol';

export type CacheReadUsage = { inputTokens: number; cachedInputTokens?: number; cacheWriteInputTokens: number };

export const isCacheReadReported = <T extends CacheReadUsage>(usage: T): usage is T & { cachedInputTokens: number } => usage.cachedInputTokens !== undefined;

export type CacheReadTally = { calls: number; notReported: number };

export const reportedCallsOf = (tally: CacheReadTally): number => tally.calls - tally.notReported;

export const noCallReported = (tally: CacheReadTally): boolean => tally.calls > 0 && tally.notReported === tally.calls;

export type InputClause = CacheReadTally & { inputTokens: number; cachedInputTokens: number | null };

export type SplitLine = { reportedInputTokens: number; splitCalls: number; calls: number; uncached: number; cacheRead: number; cacheWrite: number };

export const CACHE_READ_TEXT = {
  inputClause: (clause: InputClause): string => {
    if (clause.cachedInputTokens === null) return `${clause.inputTokens} input (cached not reported: ${CACHE_READS_NOT_REPORTED} in all ${clause.calls} call(s))`;
    if (clause.notReported === 0) return `${clause.inputTokens} input (${clause.cachedInputTokens} cached)`;
    return `${clause.inputTokens} input (${clause.cachedInputTokens} cached in ${reportedCallsOf(clause)} of ${clause.calls} call(s); ${CACHE_READS_NOT_REPORTED} in ${clause.notReported} call(s))`;
  },
  breakdownExclusion: (notReported: number, calls: number): string =>
    `${CACHE_READS_NOT_REPORTED}: ${notReported} of ${calls} call(s) are left out of the cache split, the cache hit ratio and the cache-miss causes`,
  split: (line: SplitLine): string =>
    `cache split of ${line.reportedInputTokens} input token(s) in ${line.splitCalls} of ${line.calls} call(s): uncached ${line.uncached} + cache read ${line.cacheRead} + cache write ${line.cacheWrite}`,
  splitUnavailable: (causes: { notReported: boolean; inconsistent: boolean }): string =>
    `cache split: not available (${[...(causes.notReported ? [CACHE_READS_NOT_REPORTED] : []), ...(causes.inconsistent ? ['a call has inconsistent usage'] : [])].join('; ')})`,
  hitRatioNotReported: `cache hit ratio: none (${CACHE_READS_NOT_REPORTED})`,
} as const;
