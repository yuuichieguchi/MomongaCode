import { ModelsEditRefused, editModelsSettings } from '@momonga/config';
import type { PlanProfile } from '@momonga/config';
import { isRecord } from '@momonga/foundation';
import type { Clock, KernelLockMechanism, LimitTiming } from '@momonga/foundation';
import { PLAN_ACCOUNT_NOT_FOUND_CODE, PLAN_ACCOUNT_NOT_SELECTABLE_CODE, PLAN_LABEL_REFUSAL, isPlanLabel, RETRY_OUTCOME, IDENTITY_UNCONFIRMED_OUTCOME } from '@momonga/protocol';
import type {
  NamedPlanAccountRef,
  PlanAccountRef,
  PlanAccountView,
  PlanAccountsResponse,
  PlanActiveResponse,
  PlanHostResetResponse,
  PlanModelsResponse,
  PlanTargetResponse,
  PlanResumeResponse,
  PlanSignInBeginResponse,
  PlanSignInCancelResponse,
  PlanSignInCompleteResponse,
  PlanSignOutResponse,
} from '@momonga/protocol';
import { GatewayError, invalidRequest, notFound, statusFor } from '../core/errors.ts';
import { retryAfterSeconds } from '../core/retry.ts';
import { PlanCredentialError, credentialErrorType, statusOf } from './auth-source.ts';
import { PLAN_OPERATION_LIMIT, limitFailureOf, withinRequestLimit } from './request-limit.ts';
import type { AccountView } from './auth-source.ts';
import { unusableReasonOf } from './catalog.ts';
import { CONFLICT_STATUS, INVALID_REQUEST_STATUS, RETRYABLE_STATUS } from './http-status.ts';
import { planProfileNamed } from './profiles.ts';
import type { PlanCatalog } from './catalog.ts';
import { ownEntry } from './own-entry.ts';
import { PlanAccountNotSelectableError } from './session.ts';
import type { PlanSessions } from './session.ts';
import type { PlanSignIn } from './signin.ts';

export type PlanTargetRef = PlanAccountRef & { name: string };

export type PlanApi = {
  accounts(targets: readonly PlanTargetRef[], signal: AbortSignal): Promise<PlanAccountsResponse>;
  setActive(body: unknown, signal: AbortSignal): Promise<PlanActiveResponse>;
  begin(body: unknown, signal: AbortSignal): Promise<PlanSignInBeginResponse>;
  complete(body: unknown, targets: readonly PlanTargetRef[], signal: AbortSignal): Promise<PlanSignInCompleteResponse>;
  cancel(body: unknown): PlanSignInCancelResponse;
  signOut(body: unknown, signal: AbortSignal): Promise<PlanSignOutResponse>;
  resume(account: string, body: unknown, targets: readonly PlanTargetRef[], signal: AbortSignal): Promise<PlanResumeResponse>;
  resetHost(): Promise<PlanHostResetResponse>;
  models(account: string, query: { profile: string | undefined; refresh: string | undefined }, signal: AbortSignal): Promise<PlanModelsResponse>;
  addTarget(account: string, body: unknown, signal: AbortSignal): Promise<PlanTargetResponse>;
};

export type PlanApiOptions = {
  profiles: Readonly<Record<string, PlanProfile>>;
  sessions: PlanSessions;
  signIn: PlanSignIn;
  clock: Clock;
  catalog: PlanCatalog;
  home: string;
  settingsFile: string;
  lock: KernelLockMechanism;
};

const stringField = (body: unknown, name: string): string => {
  const value = isRecord(body) ? body[name] : undefined;
  if (typeof value !== 'string' || value === '') throw invalidRequest('invalid_body', `${name} must be a non-empty string`, name);
  return value;
};

const accountLabelOf = (value: string): string => {
  if (!isPlanLabel(value)) throw invalidRequest('invalid_account_label', PLAN_LABEL_REFUSAL, 'account');
  return value;
};

const accountRefOf = (body: unknown): NamedPlanAccountRef => ({ profile: stringField(body, 'profile'), account: accountLabelOf(stringField(body, 'account')) });

const optionalBoolean = (body: unknown, name: string): boolean | undefined => {
  const value = isRecord(body) ? body[name] : undefined;
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalidRequest('invalid_body', `${name} must be a boolean`, name);
  return value;
};

const portOf = (body: unknown): number => {
  const value = isRecord(body) ? body['port'] : undefined;
  if (typeof value !== 'number') throw invalidRequest('invalid_body', 'port must be a number', 'port');
  return value;
};

const MODELS_EDIT_CONFLICTS: ReadonlySet<ModelsEditRefused['code']> = new Set<ModelsEditRefused['code']>(['name_taken', 'duplicate', 'would_not_load']);

export const planRouteError = (error: unknown): unknown => {
  if (error instanceof PlanAccountNotSelectableError) return invalidRequest(PLAN_ACCOUNT_NOT_SELECTABLE_CODE, error.message, null, CONFLICT_STATUS);
  if (error instanceof ModelsEditRefused) return invalidRequest(error.code, error.message, null, MODELS_EDIT_CONFLICTS.has(error.code) ? CONFLICT_STATUS : INVALID_REQUEST_STATUS);
  const failure = error instanceof PlanCredentialError ? error : limitFailureOf(error);
  if (failure === undefined) return error;
  const type = credentialErrorType(failure.code);
  return new GatewayError({
    status: failure.retryable ? RETRYABLE_STATUS : statusFor(type, failure.code),
    type,
    code: failure.code,
    message: failure.message,
    ...(failure.retryAfterMs === undefined ? {} : { headers: { 'retry-after': retryAfterSeconds(failure.retryAfterMs) } }),
  });
};

const translated = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw planRouteError(error);
  }
};

export const withinPlanOperation = <T>(timing: LimitTiming, signal: AbortSignal, step: (signal: AbortSignal) => Promise<T>): Promise<T> =>
  translated(() => withinRequestLimit(PLAN_OPERATION_LIMIT, timing, signal, step));

export const accountViewOf = (ref: NamedPlanAccountRef, view: AccountView, active: boolean, pinnedBy: readonly string[], nowMs: number): PlanAccountView | undefined => {
  const status = statusOf(view, nowMs);
  if (status.state === 'absent') return undefined;
  const email = view.kind === 'record' ? view.record.email : undefined;
  return {
    profile: ref.profile,
    label: ref.account,
    ...(email === undefined ? {} : { email }),
    state: status.state,
    active,
    pinnedBy,
    ...(status.paused === undefined ? {} : { paused: status.paused.until === undefined ? {} : { until: new Date(status.paused.until).toISOString() } }),
    ...(status.cause === undefined ? {} : { cause: status.cause }),
  };
};

export const createPlanApi = (options: PlanApiOptions): PlanApi => {
  const { sessions } = options;

  const profileOf = (id: string): PlanProfile => planProfileNamed(options.profiles, id);

  const accountNotFound = (ref: NamedPlanAccountRef): GatewayError => notFound(PLAN_ACCOUNT_NOT_FOUND_CODE, `no ${ref.profile} account is labelled ${JSON.stringify(ref.account)}`, 'account');

  const activeLabels = (): ReadonlyMap<string, string> =>
    new Map(
      Object.keys(options.profiles).flatMap((profile): Array<[string, string]> => {
        const label = sessions.activeLabel(profile);
        return label === undefined ? [] : [[profile, label]];
      }),
    );

  const pinnedBy = (ref: NamedPlanAccountRef, targets: readonly PlanTargetRef[]): string[] => targets.filter((target) => target.profile === ref.profile && target.account === ref.account).map((target) => target.name);

  const viewNamed = async (ref: NamedPlanAccountRef, targets: readonly PlanTargetRef[], signal: AbortSignal): Promise<PlanAccountView> => {
    const active = activeLabels();
    await sessions.load(ref, signal);
    const found = (await sessions.known(signal)).find((entry) => entry.profile === ref.profile && entry.account === ref.account);
    const view = found === undefined ? undefined : accountViewOf(ref, found.view, active.get(ref.profile) === ref.account, pinnedBy(ref, targets), options.clock.now());
    if (view === undefined) throw accountNotFound(ref);
    return view;
  };

  const accounts = async (targets: readonly PlanTargetRef[], signal: AbortSignal): Promise<PlanAccountsResponse> => {
    const active = activeLabels();
    const referenced: NamedPlanAccountRef[] = [
      ...[...active].map(([profile, account]) => ({ profile, account })),
      ...targets.flatMap((target) => (target.account === undefined ? [] : [{ profile: target.profile, account: target.account }])),
    ];
    await Promise.all(referenced.map((ref) => sessions.load(ref, signal)));
    const known = await sessions.known(signal);
    const listProblems = sessions.listProblems();
    return {
      ...(listProblems.length === 0 ? {} : { listProblems }),
      profiles: Object.values(options.profiles).map((profile) => ({ id: profile.id, usageUrl: profile.usageUrl, messages: profile.messages, loginLabel: profile.loginLabel })),
      accounts: known.flatMap((entry) => {
        const ref = { profile: entry.profile, account: entry.account };
        const view = accountViewOf(ref, entry.view, active.get(entry.profile) === entry.account, pinnedBy(ref, targets), options.clock.now());
        return view === undefined ? [] : [view];
      }),
    };
  };

  const signedInRef = async (profile: string | undefined, label: string, signal: AbortSignal): Promise<{ profile: PlanProfile; account: string }> => {
    const account = accountLabelOf(label);
    if (profile === undefined || profile === '') throw invalidRequest('invalid_query', 'the profile query parameter is required', 'profile');
    const chosen = profileOf(profile);
    const ref = { profile: chosen.id, account };
    if ((await sessions.registration(ref, signal)) === undefined) throw accountNotFound(ref);
    return { profile: chosen, account };
  };

  const addedModelOf = async (profile: string, slug: string, signal: AbortSignal): Promise<string> => {
    const connection = { adapter: 'open-responses' as const, plan: { profile } };
    const { model } = await editModelsSettings(options.home, options.settingsFile, [{ kind: 'addModel', choice: { connection, model: { id: slug } } }], { lock: options.lock, signal, planProfiles: options.profiles });
    if (model === undefined) throw new TypeError(`the settings writer added the plan model ${slug} without naming it`);
    return model;
  };

  const models = (account: string, query: { profile: string | undefined; refresh: string | undefined }, signal: AbortSignal): Promise<PlanModelsResponse> =>
    translated(async () => {
      const ref = await signedInRef(query.profile, account, signal);
      return options.catalog.read({ ...ref, refresh: query.refresh === '1', auth: sessions.authSource({ profile: ref.profile.id, account }), signal });
    });

  const addTarget = (account: string, body: unknown, signal: AbortSignal): Promise<PlanTargetResponse> =>
    translated(async () => {
      const ref = await signedInRef(stringField(body, 'profile'), account, signal);
      const slug = stringField(body, 'slug');
      const record = await options.catalog.record(ref.profile.id, account, signal);
      const entry = record === undefined ? undefined : ownEntry(record.models, slug);
      if (entry === undefined) throw notFound('plan_model_unknown', `the ${ref.profile.messages.identityLabel} model list of ${account} has no model ${JSON.stringify(slug)}; momonga models catalog lists them`, 'slug');
      if ('unreported' in entry) throw invalidRequest('plan_model_unusable', `the model ${slug} cannot be added: ${unusableReasonOf(entry)}`, 'slug');
      return { model: await addedModelOf(ref.profile.id, slug, signal) };
    });

  return {
    models,
    addTarget,
    accounts,
    setActive: (body, signal) =>
      translated(async () => {
        const ref = accountRefOf(body);
        profileOf(ref.profile);
        await sessions.selectActive(ref, signal);
        return { active: ref };
      }),
    begin: (body, signal) =>
      translated(async () => {
        const reconsent = optionalBoolean(body, 'reconsent');
        return options.signIn.begin({ ...accountRefOf(body), port: portOf(body), ...(reconsent === undefined ? {} : { reconsent }) }, signal);
      }),
    complete: (body, targets, signal) =>
      translated(async () => {
        const attemptId = stringField(body, 'attemptId');
        const end = optionalBoolean(body, 'identityConfirmed') === true ? await options.signIn.confirm(attemptId, signal) : await options.signIn.complete(attemptId, stringField(body, 'callbackUrl'), signal);
        if (end.outcome === RETRY_OUTCOME || end.outcome === IDENTITY_UNCONFIRMED_OUTCOME) return end;
        return { outcome: end.outcome, account: await viewNamed(end.ref, targets, signal), firstSignIn: end.firstSignIn };
      }),
    cancel: (body) => ({ cancelled: options.signIn.cancel(stringField(body, 'attemptId')) }),
    signOut: (body, signal) =>
      translated(async () => {
        const ref = accountRefOf(body);
        profileOf(ref.profile);
        await sessions.load(ref, signal);
        if (!(await sessions.known(signal)).some((entry) => entry.profile === ref.profile && entry.account === ref.account)) throw accountNotFound(ref);
        const report = await sessions.signOut(ref, signal);
        return { revocation: report.revocation, usageUrl: report.usageUrl };
      }),
    resume: (account, body, targets, signal) =>
      translated(async () => {
        const ref = { profile: stringField(body, 'profile'), account: accountLabelOf(account) };
        profileOf(ref.profile);
        await viewNamed(ref, targets, signal);
        return { resumed: await sessions.resume(ref, signal) };
      }),
    resetHost: () =>
      translated(async () => {
        const { hostId } = await options.signIn.resetHost();
        return { hostId };
      }),
  };
};
