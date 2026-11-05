import { ConfigError } from '@momonga/config';
import { SandboxPolicyError } from '@momonga/sandbox';
import { InheritanceError } from '@momonga/store';
import { EarlierAttemptNotStoppedError } from '@momonga/tools';
import { GatewayRequestError } from '../gateway-client.ts';

const STREAM_INTERRUPTED_REFUNDS = 3;
const REQUEUEABLE_HOP_STATUSES: readonly number[] = [408, 409];

export const INHERITANCE_FAILURE_MESSAGE = 'The previous conversation could not be loaded. Start a new conversation (/clear) to continue.';

export type FailureDisposition =
  | { kind: 'fail'; code: string; message: string }
  | { kind: 'timeout' }
  | { kind: 'defer'; code: string; message: string; retryAfterMs: number }
  | { kind: 'requeue'; refund: boolean; retryAfterMs: number; interrupted: boolean };

export const dispositionOf = (error: unknown, interruptions: number): FailureDisposition => {
  if (error instanceof ConfigError) return { kind: 'fail', code: 'config_error', message: error.message };
  if (error instanceof SandboxPolicyError) return { kind: 'fail', code: 'sandbox_policy_error', message: error.message };
  if (error instanceof InheritanceError) return { kind: 'fail', code: error.code, message: INHERITANCE_FAILURE_MESSAGE };
  if (error instanceof EarlierAttemptNotStoppedError) return { kind: 'fail', code: error.code, message: error.message };
  if (!(error instanceof GatewayRequestError)) return { kind: 'fail', code: 'internal_error', message: error instanceof Error ? error.message : String(error) };
  const retryAfterMs = error.retryAfterMs ?? 0;
  if (error.code === 'deadline_exceeded') return { kind: 'timeout' };
  if (error.deferred === true) return { kind: 'defer', code: error.code, message: error.message, retryAfterMs };
  if (error.code === 'gateway_unavailable' && error.provenNotSent === true) return { kind: 'requeue', refund: true, retryAfterMs, interrupted: false };
  if (error.status === 503 && error.code === 'gateway_closed') return { kind: 'requeue', refund: true, retryAfterMs, interrupted: false };
  if (error.code === 'stream_interrupted') return { kind: 'requeue', refund: interruptions < STREAM_INTERRUPTED_REFUNDS, retryAfterMs, interrupted: true };
  if (error.type === 'transport' || REQUEUEABLE_HOP_STATUSES.includes(error.status)) return { kind: 'requeue', refund: false, retryAfterMs, interrupted: false };
  return { kind: 'fail', code: error.code, message: error.message };
};
