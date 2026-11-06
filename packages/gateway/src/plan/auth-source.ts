import type { PlanProfile } from '@momonga/config';
import type { PlanAccountState } from '@momonga/protocol';
import type { PlanRecord } from './session.ts';

export class PlanCredentialError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'PlanCredentialError';
    this.code = code;
    this.retryable = retryable;
  }
}

export type AccountView = { kind: 'absent' } | { kind: 'unreadable'; cause: string } | { kind: 'record'; record: PlanRecord; unwritable: string | undefined };

export type PlanPause = { until?: number };

export type PlanStatus = { state: PlanAccountState | 'absent'; cause?: string; paused?: PlanPause };

export type HealthReason = 'sign_in_required' | 'plan_use_not_enabled' | 'plan_usage_paused' | 'store_unreadable' | 'store_unwritable';

export type PlanHealth = { ok: boolean; reason?: HealthReason; detail?: string; remediation?: string };

export type PlanRead = { bearer: string; generation: number };

export type AuthSource = {
  read(signal: AbortSignal): Promise<PlanRead>;
  rejected(generation: number, signal: AbortSignal): Promise<'renewed' | 'unchanged'>;
  pause(pause: { untilMs?: number }): Promise<void>;
  resume(): Promise<void>;
  status(): PlanStatus;
  health(): PlanHealth;
};

type Condition = { reason: HealthReason; code: string; detail: string };

const REGISTRATION_INVALID_MESSAGE = 'the registration is no longer valid; sign out of this account and sign in again';

const INVALID_CLIENT_CAUSE = 'invalid_client';

const SIGN_IN_STATES: ReadonlySet<PlanAccountState> = new Set<PlanAccountState>(['needs_sign_in', 'signing_out', 'registered']);

export const signInRequiredMessage = (profile: PlanProfile, record: PlanRecord | undefined): string => {
  if (record?.cause === INVALID_CLIENT_CAUSE) return REGISTRATION_INVALID_MESSAGE;
  if (record?.cause !== undefined) return profile.messages.signInExpiredMessage;
  return `Not signed in to ${profile.displayName}`;
};

export const activePause = (record: PlanRecord, nowMs: number): PlanPause | undefined => {
  const paused = record.paused;
  if (paused === undefined) return undefined;
  return paused.until === undefined || nowMs < paused.until ? paused : undefined;
};

export const blockingCondition = (profile: PlanProfile, view: AccountView, nowMs: number): Condition | undefined => {
  if (view.kind === 'unreadable') return { reason: 'store_unreadable', code: 'plan_store_unreadable', detail: view.cause };
  if (view.kind === 'absent' || SIGN_IN_STATES.has(view.record.state)) {
    return { reason: 'sign_in_required', code: 'sign_in_required', detail: signInRequiredMessage(profile, view.kind === 'absent' ? undefined : view.record) };
  }
  if (view.record.state === 'plan_disabled') return { reason: 'plan_use_not_enabled', code: 'plan_use_not_enabled', detail: profile.messages.planNotEnabledMessage };
  if (activePause(view.record, nowMs) !== undefined) return { reason: 'plan_usage_paused', code: 'plan_usage_paused', detail: profile.messages.usageLimitMessage };
  return undefined;
};

export const unwritableFailure = (cause: string): PlanCredentialError =>
  new PlanCredentialError('plan_store_unwritable', `the plan session could not be saved and its access token has expired: ${cause}`, false);

export const unavailableFailure = (): PlanCredentialError =>
  new PlanCredentialError('plan_credential_unavailable', 'the plan access token could not be refreshed; try again', true);

export const hostIdentityFailure = (error: unknown): PlanCredentialError =>
  new PlanCredentialError('plan_host_identity_unavailable', error instanceof Error ? error.message : String(error), false);

export const conditionFailure = (condition: Condition): PlanCredentialError => new PlanCredentialError(condition.code, condition.detail, false);

const remediationOf = (reason: HealthReason, profile: PlanProfile, label: string): string => {
  const login = `momonga auth login ${profile.id} --account ${label}`;
  switch (reason) {
    case 'sign_in_required':
      return `sign in with /login in the app, or run \`${login}\``;
    case 'plan_use_not_enabled':
      return `sign in with consent: /login in the app, or run \`${login} --reconsent\``;
    case 'plan_usage_paused':
      return `resume plan use in the account picker, or run \`momonga auth resume ${label}\``;
    case 'store_unreadable':
    case 'store_unwritable':
      return `repair the plan session store for this account, then sign in again with /login in the app, or run \`${login}\``;
  }
};

export const healthOf = (profile: PlanProfile, label: string | undefined, view: AccountView, nowMs: number): PlanHealth => {
  const condition =
    blockingCondition(profile, view, nowMs) ??
    (view.kind === 'record' && view.unwritable !== undefined ? { reason: 'store_unwritable' as const, code: 'plan_store_unwritable', detail: view.unwritable } : undefined);
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
