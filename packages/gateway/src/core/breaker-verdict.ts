import type { CircuitBreaker } from '@momonga/foundation';
import { ADAPTER_NEUTRAL_ERROR_CODES } from '@momonga/protocol';
import type { ErrorType } from '@momonga/protocol';

export type BreakerVerdict = 'neutral' | 'failure';

const NEUTRAL_TYPES: ReadonlySet<ErrorType> = new Set(['invalid_request', 'not_found', 'too_many_requests']);
const NEUTRAL_CODES: ReadonlySet<string> = new Set(ADAPTER_NEUTRAL_ERROR_CODES);

export const breakerVerdictOf = (type: ErrorType, code: string | null): BreakerVerdict =>
  NEUTRAL_TYPES.has(type) || (code !== null && NEUTRAL_CODES.has(code)) ? 'neutral' : 'failure';

export const applyBreakerVerdict = (breaker: CircuitBreaker, verdict: BreakerVerdict): void => {
  if (verdict === 'neutral') breaker.onNeutral();
  else breaker.onFailure();
};
