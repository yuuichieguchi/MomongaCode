import { ConfigError } from '@momonga/config';
import { TRANSIENT_REQUEST_STATUSES } from '@momonga/foundation';
import { SandboxPolicyError } from '@momonga/sandbox';
import { InheritanceError, JournalThreadError } from '@momonga/store';
import { EarlierAttemptNotStoppedError } from '@momonga/tools';
import { GatewayFailureError } from './errors.ts';
import { GatewayRequestError } from '../gateway-client.ts';

const STREAM_INTERRUPTED_REFUNDS = 3;
const PROVIDER_UNAVAILABLE_CODE = 'provider_unavailable';
const SERVICE_UNAVAILABLE_STATUS = 503;
const DEFERRAL_FAILURE_CODE = 'rate_limited';
const GATEWAY_FAILURE_CODE = 'gateway_failure';
const JOURNAL_THREAD_FAILURE_CODE = 'journal_thread_error';

export const INHERITANCE_FAILURE_MESSAGE = 'The previous conversation could not be loaded. Start a new conversation (/clear) to continue.';

export type FailureDisposition =
  | { kind: 'fail'; code: string; message: string }
  | { kind: 'timeout' }
  | { kind: 'defer'; code: string; message: string; retryAfterMs: number }
  | { kind: 'requeue'; refund: boolean; retryAfterMs: number; interrupted: boolean };

export const observedCodeOf = (error: unknown): string => {
  if (error instanceof GatewayRequestError) return error.code;
  if (error instanceof GatewayFailureError) return GATEWAY_FAILURE_CODE;
  if (error instanceof JournalThreadError) return JOURNAL_THREAD_FAILURE_CODE;
  throw new TypeError('only a gateway or journal thread failure is requeued, and this one is neither', { cause: error });
};

export const dispositionOf = (error: unknown, interruptions: number): FailureDisposition => {
  if (error instanceof ConfigError) return { kind: 'fail', code: 'config_error', message: error.message };
  if (error instanceof SandboxPolicyError) return { kind: 'fail', code: 'sandbox_policy_error', message: error.message };
  if (error instanceof InheritanceError) return { kind: 'fail', code: error.code, message: INHERITANCE_FAILURE_MESSAGE };
  if (error instanceof EarlierAttemptNotStoppedError) return { kind: 'fail', code: error.code, message: error.message };
  if (error instanceof GatewayFailureError) return { kind: 'requeue', refund: false, retryAfterMs: 0, interrupted: false };
  if (error instanceof JournalThreadError) return { kind: 'requeue', refund: false, retryAfterMs: 0, interrupted: false };
  if (!(error instanceof GatewayRequestError)) return { kind: 'fail', code: 'internal_error', message: error instanceof Error ? error.message : String(error) };
  const retryAfterMs = error.retryAfterMs ?? 0;
  if (error.code === 'deadline_exceeded') return { kind: 'timeout' };
  if (error.deferred === true) return { kind: 'defer', code: DEFERRAL_FAILURE_CODE, message: error.message, retryAfterMs };
  if (error.code === 'gateway_unavailable' && error.provenNotSent === true) return { kind: 'requeue', refund: true, retryAfterMs, interrupted: false };
  if (error.status === 503 && error.code === 'gateway_closed') return { kind: 'requeue', refund: true, retryAfterMs, interrupted: false };
  if (error.code === 'stream_interrupted') return { kind: 'requeue', refund: interruptions < STREAM_INTERRUPTED_REFUNDS, retryAfterMs, interrupted: true };
  if (error.type === 'transport' || error.code === PROVIDER_UNAVAILABLE_CODE || error.status === SERVICE_UNAVAILABLE_STATUS || TRANSIENT_REQUEST_STATUSES.includes(error.status)) return { kind: 'requeue', refund: false, retryAfterMs, interrupted: false };
  return { kind: 'fail', code: error.code, message: error.message };
};
