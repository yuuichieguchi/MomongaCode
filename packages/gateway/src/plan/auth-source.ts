import type { PlanProfile } from '@momonga/config';
import {
  PLAN_CREDENTIAL_UNAVAILABLE_CODE,
  PLAN_HOST_IDENTITY_UNAVAILABLE_CODE,
  PLAN_STORE_UNREADABLE_CODE,
  PLAN_STORE_UNWRITABLE_CODE,
  PLAN_USE_NOT_ENABLED_CODE,
  SIGN_IN_REQUIRED_CODE,
  USAGE_PAUSED_CODE,
} from '@momonga/protocol';
import type { ErrorType, PlanAccountRef, PlanAccountState, PlanHealthReason } from '@momonga/protocol';
import { storeReadFailure } from './record-io.ts';
import type { PlanRecord } from './session.ts';

export class PlanCredentialError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(code: string, message: string, retryable: boolean, extra: { retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, 'cause' in extra ? { cause: extra.cause } : undefined);
    this.name = 'PlanCredentialError';
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = extra.retryAfterMs;
  }
}

const CREDENTIAL_ERROR_TYPES: Readonly<Record<string, ErrorType>> = {
  [SIGN_IN_REQUIRED_CODE]: 'invalid_request',
  [PLAN_USE_NOT_ENABLED_CODE]: 'invalid_request',
  [USAGE_PAUSED_CODE]: 'too_many_requests',
};

export const credentialErrorType = (code: string): ErrorType => CREDENTIAL_ERROR_TYPES[code] ?? 'server_error';

export type AccountView = { kind: 'absent' } | { kind: 'unreadable'; cause: string } | { kind: 'record'; record: PlanRecord; unwritable: string | undefined };

export type PlanPause = { until?: number };

export type PlanStatus = { state: PlanAccountState | 'absent'; cause?: string; paused?: PlanPause };

export type PlanHealth = { ok: boolean; reason?: PlanHealthReason; detail?: string; remediation?: string };

export type PlanRead = { bearer: string | undefined; generation: number };

export type AuthSource = {
  read(signal: AbortSignal): Promise<PlanRead>;
  rejected(generation: number, signal: AbortSignal): Promise<'renewed' | 'unchanged'>;
  pause(pause: { untilMs?: number; code: string }, signal: AbortSignal): Promise<void>;
  resume(signal: AbortSignal): Promise<void>;
  status(): PlanStatus;
  health(): PlanHealth;
  resolvedAccount(): PlanAccountRef | undefined;
};

type Condition = { reason: PlanHealthReason; code: string; detail: string; retryAfterMs?: number };

const REGISTRATION_INVALID_MESSAGE = 'the registration is no longer valid; sign out of this account and sign in again';

const INVALID_CLIENT_CAUSE = 'invalid_client';

const SIGN_IN_STATES: ReadonlySet<PlanAccountState> = new Set<PlanAccountState>(['needs_sign_in', 'signing_out', 'registered']);

export const signInRequiredMessage = (profile: PlanProfile, record: PlanRecord | undefined): string => {
  if (record?.state !== 'needs_sign_in') return profile.messages.signInRequiredMessage;
  return record.cause === INVALID_CLIENT_CAUSE ? REGISTRATION_INVALID_MESSAGE : profile.messages.signInExpiredMessage;
};

export const activePause = (record: PlanRecord, nowMs: number): PlanPause | undefined => {
  const paused = record.paused;
  if (paused === undefined) return undefined;
  return paused.until === undefined || nowMs < paused.until ? paused : undefined;
};

export const blockingCondition = (profile: PlanProfile, view: AccountView, nowMs: number): Condition | undefined => {
  if (view.kind === 'unreadable') return { reason: 'store_unreadable', code: PLAN_STORE_UNREADABLE_CODE, detail: view.cause };
  if (view.kind === 'absent' || SIGN_IN_STATES.has(view.record.state)) {
    return { reason: SIGN_IN_REQUIRED_CODE, code: SIGN_IN_REQUIRED_CODE, detail: signInRequiredMessage(profile, view.kind === 'absent' ? undefined : view.record) };
  }
  if (view.record.state === 'plan_disabled') return { reason: PLAN_USE_NOT_ENABLED_CODE, code: PLAN_USE_NOT_ENABLED_CODE, detail: profile.messages.planNotEnabledMessage };
  const pause = activePause(view.record, nowMs);
  if (pause !== undefined) {
    return { reason: USAGE_PAUSED_CODE, code: USAGE_PAUSED_CODE, detail: profile.messages.usageLimitMessage, ...(pause.until === undefined ? {} : { retryAfterMs: pause.until - nowMs }) };
  }
  return undefined;
};

export const unwritableFailure = (cause: string): PlanCredentialError =>
  new PlanCredentialError(PLAN_STORE_UNWRITABLE_CODE, `the plan session could not be saved and its access token has expired: ${cause}`, false);

export const unavailableFailure = (): PlanCredentialError =>
  new PlanCredentialError(PLAN_CREDENTIAL_UNAVAILABLE_CODE, 'the plan access token could not be refreshed; try again', true);

export const hostIdentityFailure = (error: unknown): PlanCredentialError =>
  new PlanCredentialError(PLAN_HOST_IDENTITY_UNAVAILABLE_CODE, error instanceof Error ? error.message : String(error), false);

export const signInRequiredCondition = (profile: PlanProfile, record: PlanRecord | undefined): Condition => ({
  reason: SIGN_IN_REQUIRED_CODE,
  code: SIGN_IN_REQUIRED_CODE,
  detail: signInRequiredMessage(profile, record),
});

export const conditionFailure = (condition: Condition): PlanCredentialError =>
  condition.code === PLAN_STORE_UNREADABLE_CODE
    ? storeReadFailure(condition.detail, undefined)
    : new PlanCredentialError(condition.code, condition.detail, false, condition.retryAfterMs === undefined ? {} : { retryAfterMs: condition.retryAfterMs });

const remediationOf = (reason: PlanHealthReason, profile: PlanProfile, label: string): string => {
  const login = `momonga auth login ${profile.id} --account ${label}`;
  switch (reason) {
    case SIGN_IN_REQUIRED_CODE:
      return `sign in with /login in the app, or run \`${login}\``;
    case PLAN_USE_NOT_ENABLED_CODE:
      return `sign in with consent: /login in the app, or run \`${login} --reconsent\``;
    case USAGE_PAUSED_CODE:
      return `resume plan use in the account picker, or run \`momonga auth resume ${label}\``;
    case 'store_unreadable':
    case 'store_unwritable':
      return `repair the plan session store for this account, then sign in again with /login in the app, or run \`${login}\``;
  }
};

export const healthOf = (profile: PlanProfile, label: string | undefined, view: AccountView, nowMs: number): PlanHealth => {
  const condition =
    blockingCondition(profile, view, nowMs) ??
    (view.kind === 'record' && view.unwritable !== undefined ? { reason: 'store_unwritable' as const, code: PLAN_STORE_UNWRITABLE_CODE, detail: view.unwritable } : undefined);
  if (condition === undefined) return { ok: true };
  return { ok: false, reason: condition.reason, detail: condition.detail, remediation: remediationOf(condition.reason, profile, label ?? '<label>') };
};

export const statusOf = (view: AccountView, nowMs: number): PlanStatus => {
  if (view.kind === 'absent') return { state: 'absent' };
  if (view.kind === 'unreadable') return { state: 'store_unreadable', cause: view.cause };
  const paused = activePause(view.record, nowMs);
  const cause = view.unwritable ?? view.record.cause;
  return {
    state: view.unwritable === undefined ? view.record.state : 'store_unwritable',
    ...(cause === undefined ? {} : { cause }),
    ...(paused === undefined ? {} : { paused }),
  };
};
