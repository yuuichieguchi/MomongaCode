export type BackoffOptions = {
  attempt: number;
  baseMs: number;
  maxMs: number;
  random: () => number;
  jitter?: 'full' | 'equal';
};

export const computeBackoff = ({ attempt, baseMs, maxMs, random, jitter = 'full' }: BackoffOptions): number => {
  if (!Number.isInteger(attempt) || attempt < 0) throw new RangeError(`computeBackoff: attempt must be a non-negative integer, got ${attempt}`);
  if (!Number.isFinite(baseMs) || baseMs < 0) throw new RangeError(`computeBackoff: baseMs must be a non-negative finite number, got ${baseMs}`);
  if (!Number.isFinite(maxMs) || maxMs < 0) throw new RangeError(`computeBackoff: maxMs must be a non-negative finite number, got ${maxMs}`);
  const exponential = baseMs * 2 ** Math.min(attempt, 1023);
  const cap = Math.min(maxMs, exponential);
  if (jitter === 'full') return Math.floor(random() * cap);
  const floor = Math.ceil(cap / 2);
  return floor + Math.floor(random() * (cap - floor));
};

const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const DELTA_SECONDS = /^\d+$/;

const safeDelay = (value: number): number | undefined => (Number.isSafeInteger(value) ? value : undefined);

export const parseRetryAfter = (value: string | null | undefined, nowMs: number): number | undefined => {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  if (DELTA_SECONDS.test(trimmed)) return safeDelay(Number(trimmed) * 1000);
  if (!HTTP_DATE.test(trimmed)) return undefined;
  const target = Date.parse(trimmed);
  if (Number.isNaN(target)) return undefined;
  return safeDelay(Math.max(0, target - nowMs));
};
