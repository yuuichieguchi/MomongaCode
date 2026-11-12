import { MAX_DATE_MS } from '@momonga/foundation';

export const isDateTime = (ms: number): boolean => Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS;

export const pauseEndOf = (nowMs: number, retryAfterMs: number | undefined): number | undefined => {
  if (retryAfterMs === undefined) return undefined;
  const end = nowMs + retryAfterMs;
  return isDateTime(end) ? end : undefined;
};
