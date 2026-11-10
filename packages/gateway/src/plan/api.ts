import { addModelConnection } from '@momonga/config';
import type { PlanProfile } from '@momonga/config';
import { isRecord } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { PLAN_ACCOUNT_NOT_SELECTABLE_CODE } from '@momonga/protocol';
import type {
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
import { PlanCredentialError, credentialErrorType, statusOf } from './auth-source.ts';
import { limitFailureOf } from './request-limit.ts';
import type { AccountView } from './auth-source.ts';
import { NO_REPORTED_WINDOW } from './catalog.ts';
import type { PlanCatalog } from './catalog.ts';
import { PLAN_LABEL_PATTERN, isPlanLabel } from './label.ts';
import { PlanAccountNotSelectableError } from './session.ts';
import type { PlanSessions } from './session.ts';
import type { PlanSignIn } from './signin.ts';

export type PlanTargetRef = { name: string; profile: string; account?: string };

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
};

const stringField = (body: unknown, name: string): string => {
  const value = isRecord(body) ? body[name] : undefined;
  if (typeof value !== 'string' || value === '') throw invalidRequest('invalid_body', `${name} must be a non-empty string`, name);
  return value;
};

const accountLabelOf = (value: string): string => {
  if (!isPlanLabel(value)) throw invalidRequest('invalid_account_label', `the account label must match ${PLAN_LABEL_PATTERN}`, 'account');
  return value;
};

const accountRefOf = (body: unknown): PlanAccountRef => ({ profile: stringField(body, 'profile'), account: accountLabelOf(stringField(body, 'account')) });

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

const RETRYABLE_STATUS = 503;
const CONFLICT_STATUS = 409;

export const gatewayErrorOfCredential = (error: unknown): unknown => {
  if (error instanceof PlanAccountNotSelectableError) return invalidRequest(PLAN_ACCOUNT_NOT_SELECTABLE_CODE, error.message, null, CONFLICT_STATUS);
  const failure = error instanceof PlanCredentialError ? error : limitFailureOf(error);
  if (failure === undefined) return error;
  const type = credentialErrorType(failure.code);
  return new GatewayError({ status: failure.retryable ? RETRYABLE_STATUS : statusFor(type, failure.code), type, code: failure.code, message: failure.message });
};

const translated = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw gatewayErrorOfCredential(error);
  }
};

export const accountViewOf = (ref: PlanAccountRef, view: AccountView, active: boolean, pinnedBy: readonly string[], nowMs: number): PlanAccountView | undefined => {
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

  const profileOf = (id: string): PlanProfile => {
    const profile = Object.hasOwn(options.profiles, id) ? options.profiles[id] : undefined;
    if (profile === undefined) throw invalidRequest('plan_profile_unknown', `no plan profile is named ${JSON.stringify(id)}`, 'profile');
    return profile;
  };

  const activeLabels = (): ReadonlyMap<string, string> =>
    new Map(
      Object.keys(options.profiles).flatMap((profile): Array<[string, string]> => {
        const label = sessions.activeLabel(profile);
        return label === undefined ? [] : [[profile, label]];
      }),
    );

  const pinnedBy = (ref: PlanAccountRef, targets: readonly PlanTargetRef[]): string[] => targets.filter((target) => target.profile === ref.profile && target.account === ref.account).map((target) => target.name);

  const viewNamed = async (ref: PlanAccountRef, targets: readonly PlanTargetRef[], signal: AbortSignal): Promise<PlanAccountView> => {
    const active = activeLabels();
    await sessions.load(ref, signal);
    const found = (await sessions.known(signal)).find((entry) => entry.profile === ref.profile && entry.account === ref.account);
    const view = found === undefined ? undefined : accountViewOf(ref, found.view, active.get(ref.profile) === ref.account, pinnedBy(ref, targets), options.clock.now());
    if (view === undefined) throw notFound('plan_account_not_found', `no ${ref.profile} account is labelled ${JSON.stringify(ref.account)}`, 'account');
    return view;
  };

  const accounts = async (targets: readonly PlanTargetRef[], signal: AbortSignal): Promise<PlanAccountsResponse> => {
    const active = activeLabels();
    const referenced: PlanAccountRef[] = [
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
    if ((await sessions.registration({ profile: chosen.id, account }, signal)) === undefined) {
      throw notFound('plan_account_not_found', `no ${chosen.id} account is labelled ${JSON.stringify(account)}`, 'account');
    }
    return { profile: chosen, account };
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
      const entry = (await options.catalog.record(ref.profile.id, account, signal))?.models[slug];
      if (entry === undefined) throw notFound('plan_model_unknown', `the ${ref.profile.messages.identityLabel} model list of ${account} has no model ${JSON.stringify(slug)}; momonga models --catalog lists them`, 'slug');
      if ('unreported' in entry) throw invalidRequest('plan_model_unusable', `the model ${slug} cannot be added: ${NO_REPORTED_WINDOW}`, 'slug');
      return addModelConnection(options.home, options.settingsFile, { kind: 'plan', profile: ref.profile.id, model: slug }, signal);
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
        const end = await options.signIn.complete(stringField(body, 'attemptId'), stringField(body, 'callbackUrl'), signal);
        if (end.outcome === 'retry') return end;
        return { outcome: end.outcome, account: await viewNamed(end.ref, targets, signal), firstSignIn: end.firstSignIn };
      }),
    cancel: (body) => ({ cancelled: options.signIn.cancel(stringField(body, 'attemptId')) }),
    signOut: (body, signal) =>
      translated(async () => {
        const ref = accountRefOf(body);
        await signedInRef(ref.profile, ref.account, signal);
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
    resetHost: async () => {
      const { hostId } = await options.signIn.resetHost();
      return { hostId };
    },
  };
};
