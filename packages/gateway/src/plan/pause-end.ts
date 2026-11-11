export const LATEST_DATE_MS = 8.64e15;

export const isDateTime = (ms: number): boolean => Number.isFinite(ms) && Math.abs(ms) <= LATEST_DATE_MS;

export const pauseEndOf = (nowMs: number, retryAfterMs: number | undefined): number | undefined => {
  if (retryAfterMs === undefined) return undefined;
  const end = nowMs + retryAfterMs;
  return isDateTime(end) ? end : undefined;
};
