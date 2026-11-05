import { ADAPTER_NEUTRAL_ERROR_CODES } from '@momonga/protocol';
import type { ErrorType } from '@momonga/protocol';
import type { BreakerOutcome } from './request-breaker.ts';

export type BreakerVerdict = Exclude<BreakerOutcome, 'success'>;

const NEUTRAL_TYPES: ReadonlySet<ErrorType> = new Set(['invalid_request', 'not_found', 'too_many_requests']);
const NEUTRAL_CODES: ReadonlySet<string> = new Set(ADAPTER_NEUTRAL_ERROR_CODES);

export const breakerVerdictOf = (type: ErrorType, code: string | null): BreakerVerdict =>
  NEUTRAL_TYPES.has(type) || (code !== null && NEUTRAL_CODES.has(code)) ? 'neutral' : 'failure';
