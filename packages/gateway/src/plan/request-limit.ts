import { HOST_READ_BOUND_MS, limitEndOf, limitEndText, operationLimit } from '@momonga/foundation';
import type { LimitTiming } from '@momonga/foundation';
import { PLAN_CREDENTIAL_UNAVAILABLE_CODE } from '@momonga/protocol';
import { PlanCredentialError } from './auth-source.ts';
import type { AuthSource } from './auth-source.ts';

export type PlanRequestLimit = { limitMs: number; label: string };

export const SIGN_IN_RECORD_STORE = 'the sign-in record store';

export const PLAN_ROUTE_BODY_BYTES = 64 * 1024;

export const PLAN_OPERATION_LIMIT: PlanRequestLimit = { limitMs: HOST_READ_BOUND_MS, label: 'the plan operation limit' };

export const limitFailureOf = (error: unknown): PlanCredentialError | undefined => {
  const end = limitEndOf(error);
  return end === undefined ? undefined : new PlanCredentialError(PLAN_CREDENTIAL_UNAVAILABLE_CODE, limitEndText(end, SIGN_IN_RECORD_STORE), false, { cause: error });
};

export const withinRequestLimit = async <T>(limit: PlanRequestLimit, timing: LimitTiming, signal: AbortSignal, step: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const bound = operationLimit(signal, limit.limitMs, limit.label, timing);
  try {
    return await step(bound.signal);
  } catch (error) {
    throw limitFailureOf(error) ?? error;
  } finally {
    bound.dispose();
  }
};

export const authSourceWithinRequestLimit = (auth: AuthSource, limit: PlanRequestLimit, timing: LimitTiming): AuthSource => ({
  ...auth,
  read: (signal) => withinRequestLimit(limit, timing, signal, (bound) => auth.read(bound)),
  rejected: (generation, signal) => withinRequestLimit(limit, timing, signal, (bound) => auth.rejected(generation, bound)),
  pause: (pause, signal) => withinRequestLimit(limit, timing, signal, (bound) => auth.pause(pause, bound)),
  resume: (signal) => withinRequestLimit(limit, timing, signal, (bound) => auth.resume(bound)),
});
