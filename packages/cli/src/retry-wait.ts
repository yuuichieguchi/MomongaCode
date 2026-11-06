import type { PublicRunEvent } from '@momonga/protocol';

export type AttemptFailed = Extract<PublicRunEvent, { type: 'attempt.failed' }>;

const WAITING_FOR: Readonly<Record<string, string>> = {
  provider_unavailable: 'Waiting to reach the provider',
  gateway_unavailable: 'Waiting to reach the provider',
  gateway_closed: 'Waiting to reach the provider',
  gateway_failure: 'Waiting to reach the provider',
  rate_limited: 'Waiting for the provider to accept requests again',
  stream_interrupted: 'Waiting after the response stream was interrupted',
  journal_thread_error: 'Waiting after the journal worker failed',
};

const OTHER_WAITING_FOR = 'Waiting to try again after a failed attempt';

const twoDigits = (value: number): string => String(value).padStart(2, '0');

export const localTime = (epochMs: number): string => {
  const at = new Date(epochMs);
  return `${twoDigits(at.getHours())}:${twoDigits(at.getMinutes())}:${twoDigits(at.getSeconds())}`;
};

export const describeRetryWait = (failure: Pick<AttemptFailed, 'code' | 'attempt' | 'limit' | 'retryAt'>): string =>
  `${WAITING_FOR[failure.code] ?? OTHER_WAITING_FOR} (attempt ${failure.attempt} of ${failure.limit}). Retrying at ${localTime(failure.retryAt)}.`;
