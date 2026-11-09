import { addModelConnection } from '@momonga/config';
import type { PlanProfile } from '@momonga/config';
import { isRecord } from '@momonga/foundation';
import type { Clock, FileSystem } from '@momonga/foundation';
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
import { GatewayError, invalidRequest, notFound } from '../core/errors.ts';
import { PlanCredentialError, statusOf } from './auth-source.ts';
import type { AccountView } from './auth-source.ts';
import { readActiveAccount } from './active-account.ts';
import { resetHostIdentity } from './host-identity.ts';
import { NO_REPORTED_WINDOW } from './catalog.ts';
import type { PlanCatalog } from './catalog.ts';
import type { PlanSessions } from './session.ts';
import type { PlanSignIn } from './signin.ts';

export type PlanTargetRef = { name: string; profile: string; account?: string };

export type PlanApi = {
  accounts(): Promise<PlanAccountsResponse>;
  setActive(body: unknown): Promise<PlanActiveResponse>;
  begin(body: unknown): Promise<PlanSignInBeginResponse>;
  complete(body: unknown): Promise<PlanSignInCompleteResponse>;
  cancel(body: unknown): PlanSignInCancelResponse;
  signOut(body: unknown): Promise<PlanSignOutResponse>;
  resume(account: string, body: unknown): Promise<PlanResumeResponse>;
  resetHost(): Promise<PlanHostResetResponse>;
  models(account: string, query: { profile: string | undefined; refresh: string | undefined }, signal: AbortSignal): Promise<PlanModelsResponse>;
  addTarget(account: string, body: unknown): Promise<PlanTargetResponse>;
};

export type PlanApiOptions = {
  profiles: Readonly<Record<string, PlanProfile>>;
  sessions: PlanSessions;
  signIn: PlanSignIn;
  fileSystem: FileSystem;
  paths: { host: string; active: string };
  clock: Clock;
  planTargets: () => readonly PlanTargetRef[];
  catalog: PlanCatalog;
  settingsFile: string;
};

const stringField = (body: unknown, name: string): string => {
  const value = isRecord(body) ? body[name] : undefined;
  if (typeof value !== 'string' || value === '') throw invalidRequest('invalid_body', `${name} must be a non-empty string`, name);
  return value;
};

const accountRefOf = (body: unknown): PlanAccountRef => ({ profile: stringField(body, 'profile'), account: stringField(body, 'account') });

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

export const gatewayErrorOfCredential = (error: unknown): unknown => {
  if (!(error instanceof PlanCredentialError)) return error;
  return new GatewayError({ status: error.retryable ? 503 : 409, type: error.retryable ? 'server_error' : 'invalid_request', code: error.code, message: error.message });
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

  const activeLabels = async (): Promise<ReadonlyMap<string, string>> => {
    const entries = await Promise.all(
      Object.keys(options.profiles).map(async (profile): Promise<Array<[string, string]>> => {
        const label = await readActiveAccount(options.fileSystem, options.paths.active, profile);
        return label === undefined ? [] : [[profile, label]];
      }),
    );
    return new Map(entries.flat());
  };

  const pinnedBy = (ref: PlanAccountRef): string[] =>
    options
      .planTargets()
      .filter((target) => target.profile === ref.profile && target.account === ref.account)
      .map((target) => target.name);

  const viewNamed = async (ref: PlanAccountRef): Promise<PlanAccountView> => {
    const active = await activeLabels();
    await sessions.load(ref);
    const found = (await sessions.known()).find((entry) => entry.profile === ref.profile && entry.account === ref.account);
    const view = found === undefined ? undefined : accountViewOf(ref, found.view, active.get(ref.profile) === ref.account, pinnedBy(ref), options.clock.now());
    if (view === undefined) throw notFound('plan_account_not_found', `no ${ref.profile} account is labelled ${JSON.stringify(ref.account)}`, 'account');
    return view;
  };

  const accounts = async (): Promise<PlanAccountsResponse> => {
    const active = await activeLabels();
    const referenced: PlanAccountRef[] = [
      ...[...active].map(([profile, account]) => ({ profile, account })),
      ...options.planTargets().flatMap((target) => (target.account === undefined ? [] : [{ profile: target.profile, account: target.account }])),
    ];
    await Promise.all(referenced.map((ref) => sessions.load(ref)));
    const known = await sessions.known();
    return {
      profiles: Object.values(options.profiles).map((profile) => ({ id: profile.id, usageUrl: profile.usageUrl, messages: profile.messages, loginLabel: profile.loginLabel })),
      accounts: known.flatMap((entry) => {
        const ref = { profile: entry.profile, account: entry.account };
        const view = accountViewOf(ref, entry.view, active.get(entry.profile) === entry.account, pinnedBy(ref), options.clock.now());
        return view === undefined ? [] : [view];
      }),
    };
  };

  const signedInRef = async (profile: string | undefined, account: string): Promise<{ profile: PlanProfile; account: string }> => {
    if (profile === undefined || profile === '') throw invalidRequest('invalid_query', 'the profile query parameter is required', 'profile');
    const chosen = profileOf(profile);
    if ((await sessions.registration({ profile: chosen.id, account })) === undefined) {
      throw notFound('plan_account_not_found', `no ${chosen.id} account is labelled ${JSON.stringify(account)}`, 'account');
    }
    return { profile: chosen, account };
  };

  const models = (account: string, query: { profile: string | undefined; refresh: string | undefined }, signal: AbortSignal): Promise<PlanModelsResponse> =>
    translated(async () => {
      const ref = await signedInRef(query.profile, account);
      return options.catalog.read({ ...ref, refresh: query.refresh === '1', auth: sessions.authSource({ profile: ref.profile.id, account }), signal });
    });

  const addTarget = (account: string, body: unknown): Promise<PlanTargetResponse> =>
    translated(async () => {
      const ref = await signedInRef(stringField(body, 'profile'), account);
      const slug = stringField(body, 'slug');
      const entry = (await options.catalog.record(ref.profile.id, account))?.models[slug];
      if (entry === undefined) throw notFound('plan_model_unknown', `the ${ref.profile.messages.identityLabel} model list of ${account} has no model ${JSON.stringify(slug)}; momonga models --catalog lists them`, 'slug');
      if ('unreported' in entry) throw invalidRequest('plan_model_unusable', `the model ${slug} cannot be added: ${NO_REPORTED_WINDOW}`, 'slug');
      return addModelConnection(options.settingsFile, { kind: 'plan', profile: ref.profile.id, model: slug });
    });

  return {
    models,
    addTarget,
    accounts,
    setActive: (body) =>
      translated(async () => {
        const ref = accountRefOf(body);
        profileOf(ref.profile);
        await sessions.selectActive(ref);
        return { active: ref };
      }),
    begin: (body) =>
      translated(async () => {
        const reconsent = optionalBoolean(body, 'reconsent');
        return options.signIn.begin({ ...accountRefOf(body), port: portOf(body), ...(reconsent === undefined ? {} : { reconsent }) });
      }),
    complete: (body) =>
      translated(async () => {
        const end = await options.signIn.complete(stringField(body, 'attemptId'), stringField(body, 'callbackUrl'));
        if (end.outcome === 'retry') return end;
        return { outcome: end.outcome, account: await viewNamed(end.ref), firstSignIn: end.firstSignIn };
      }),
    cancel: (body) => ({ cancelled: options.signIn.cancel(stringField(body, 'attemptId')) }),
    signOut: (body) =>
      translated(async () => {
        const ref = accountRefOf(body);
        profileOf(ref.profile);
        const report = await sessions.signOut(ref);
        return { revocation: report.revocation, usageUrl: report.usageUrl };
      }),
    resume: (account, body) =>
      translated(async () => {
        const ref = { profile: stringField(body, 'profile'), account };
        profileOf(ref.profile);
        await viewNamed(ref);
        return { resumed: await sessions.resume(ref) };
      }),
    resetHost: async () => {
      const { hostId } = await resetHostIdentity(options.fileSystem, options.paths.host);
      return { hostId };
    },
  };
};
