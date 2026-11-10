import path from 'node:path';
import type { PlanProfile } from '@momonga/config';
import { hostKernelLock, isAtomicWriteTemporary, isRecord, isTransientErrno, sweepLeftovers, systemRandom } from '@momonga/foundation';
import type { Clock, CredentialEntry, FileSystem, KernelLockMechanism, ListableCredentialStore } from '@momonga/foundation';
import { PLAN_ACCOUNT_STATES } from '@momonga/protocol';
import type { PlanAccountState, PlanListProblem } from '@momonga/protocol';
import { GATEWAY_CONFIG_DEFAULTS, PLAN_SESSION_DEFAULTS } from '../defaults.ts';
import type { WaitPolicy } from '../core/retry.ts';
import { readActivePointer, writeActiveAccount } from './active-account.ts';
import {
  PlanCredentialError,
  blockingCondition,
  conditionFailure,
  healthOf,
  hostIdentityFailure,
  signInRequiredMessage,
  statusOf,
  unavailableFailure,
  unwritableFailure,
} from './auth-source.ts';
import type { AccountView, AuthSource, PlanPause, PlanRead, PlanStatus } from './auth-source.ts';
import { noPlanEvents } from './events.ts';
import type { PlanEvents } from './events.ts';
import { ensureHostIdentity } from './host-identity.ts';
import type { PlanOutbound } from './outbound.ts';
import { grantsScope, refreshRequiredFor, sendRefresh, sendWasInterrupted, tokenResponseProblem } from './refresh.ts';
import type { PlanFetch, PlanSleep, PlanTokenResponse, RefreshEnd } from './refresh.ts';
import { revokeRefreshToken } from './revoke.ts';
import type { RevocationAnswer } from './revoke.ts';

export type { PlanFetch, PlanSleep, PlanTokenResponse } from './refresh.ts';
export { PlanCredentialError } from './auth-source.ts';
export type { AuthSource, PlanHealth, PlanRead, PlanStatus } from './auth-source.ts';

const RECORD_VERSION = 1;

type RecordState = Exclude<PlanAccountState, 'store_unreadable' | 'store_unwritable'>;

const RECORD_STATES: ReadonlySet<string> = new Set(PLAN_ACCOUNT_STATES.filter((state) => state !== 'store_unreadable' && state !== 'store_unwritable'));

export type PlanRecord = {
  version: number;
  profile: string;
  account: string;
  state: RecordState;
  client_id: string;
  ext_agent_host_id: string;
  welcomeShown: boolean;
  subject?: string;
  email?: string;
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expiresAt?: number;
  scope?: string;
  earliestRefreshAt?: string;
  generation?: number;
  pendingRefresh?: { generation: number; startedAt: number };
  cause?: string;
  interrupted?: boolean;
  paused?: PlanPause;
};

export type PlanPaths = { sessions: string; host: string; active: string };

export type PlanAccountRef = { profile: string; account: string };

export type OpenPlanSessionsOptions = {
  profiles: Readonly<Record<string, PlanProfile>>;
  paths: PlanPaths;
  store: ListableCredentialStore;
  fileSystem: FileSystem;
  accounts: readonly PlanAccountRef[];
  clock: Clock;
  outbound: PlanOutbound;
  sleep: PlanSleep;
  onSecret(value: string): void;
  warn(message: string): void;
  lock?: KernelLockMechanism;
  random?: () => number;
  events?: PlanEvents;
};

export type RegisterInput = { profile: string; account: string; clientId: string; hostId: string };

export type InstallInput = RegisterInput & { subject: string; email?: string; idToken: string; tokens: PlanTokenResponse };

export type Installed = { outcome: 'signed_in' | 'plan_disabled'; firstSignIn: boolean };

export type Registration = { state: RecordState; clientId: string; subject?: string; email?: string; idToken?: string };

export type KnownAccount = { profile: string; account: string; view: AccountView };

export type Rejected = { outcome: 'rejected'; reason: 'registration_superseded' };

export type SignOutReport = { revocation: RevocationAnswer; usageUrl: string };

export type PlanSessions = {
  register(input: RegisterInput): Promise<{ outcome: 'registered' } | Rejected>;
  install(input: InstallInput): Promise<Installed | Rejected>;
  registration(ref: PlanAccountRef): Promise<Registration | undefined>;
  load(ref: PlanAccountRef): Promise<void>;
  known(): Promise<readonly KnownAccount[]>;
  listProblems(): readonly PlanListProblem[];
  resume(ref: PlanAccountRef): Promise<boolean>;
  selectActive(ref: PlanAccountRef): Promise<void>;
  signOut(ref: PlanAccountRef, signal: AbortSignal): Promise<SignOutReport>;
  authSource(target: { profile: string; account?: string }): AuthSource;
  signedOutSource(profile: string): AuthSource;
  serve(refs: readonly PlanAccountRef[]): Promise<void>;
  activeLabel(profile: string): string | undefined;
  readonly lifetime: AbortSignal;
  close(): Promise<void>;
};

type Loaded = { kind: 'absent' } | { kind: 'unreadable'; cause: string } | { kind: 'record'; record: PlanRecord };

type Account = {
  key: string;
  profile: PlanProfile;
  label: string;
  loaded: Loaded | undefined;
  loading: Promise<void> | undefined;
  dirty: boolean;
  unwritable: string | undefined;
  interrupted: boolean;
  inflight: Promise<void> | undefined;
  forced: Map<number, Promise<void>>;
  persisting: boolean;
  resumedSignOut: Promise<SignOutReport> | undefined;
};

type RefreshTrigger = { kind: 'lazy' } | { kind: 'forced'; generation: number };

const RECORD_KEY_PREFIX = 'plan/';

const recordKey = (profile: string, account: string): string => `${RECORD_KEY_PREFIX}${profile}/${account}`;

const refOfKey = (key: string): PlanAccountRef | undefined => {
  if (!key.startsWith(RECORD_KEY_PREFIX)) return undefined;
  const rest = key.slice(RECORD_KEY_PREFIX.length);
  const separator = rest.indexOf('/');
  if (separator <= 0 || separator === rest.length - 1) return undefined;
  return { profile: rest.slice(0, separator), account: rest.slice(separator + 1) };
};

export const planRecordKeyOfPlaintext = (text: string): string => {
  const record = parseRecord(text);
  return recordKey(record.profile, record.account);
};

const optional = <K extends string, V>(name: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [name]: value } as { [P in K]?: V }));

const stringField = (source: Record<string, unknown>, name: string): string | undefined => {
  const value = source[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`the plan record field ${name} is not a string`);
  return value;
};

const numberField = (source: Record<string, unknown>, name: string): number | undefined => {
  const value = source[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`the plan record field ${name} is not a number`);
  return value;
};

const booleanField = (source: Record<string, unknown>, name: string): boolean | undefined => {
  const value = source[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`the plan record field ${name} is not a boolean`);
  return value;
};

const requiredString = (source: Record<string, unknown>, name: string): string => {
  const value = stringField(source, name);
  if (value === undefined) throw new Error(`the plan record has no ${name}`);
  return value;
};

const parsePause = (value: unknown): PlanPause | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('the plan record field paused is not an object');
  const until = numberField(value, 'until');
  return until === undefined ? {} : { until };
};

const parsePending = (value: unknown): PlanRecord['pendingRefresh'] => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('the plan record field pendingRefresh is not an object');
  const generation = numberField(value, 'generation');
  const startedAt = numberField(value, 'startedAt');
  if (generation === undefined || startedAt === undefined) throw new Error('the plan record field pendingRefresh is incomplete');
  return { generation, startedAt };
};

const parseRecord = (text: string): PlanRecord => {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error('the plan record is not a JSON object');
  const version = numberField(value, 'version');
  if (version !== RECORD_VERSION) throw new Error(`the plan record has version ${String(version)}, and this build reads version ${RECORD_VERSION}`);
  const state = requiredString(value, 'state');
  if (!RECORD_STATES.has(state)) throw new Error(`the plan record has an unknown state ${JSON.stringify(state)}`);
  const welcomeShown = value['welcomeShown'];
  if (typeof welcomeShown !== 'boolean') throw new Error('the plan record has no welcomeShown');
  return {
    version,
    profile: requiredString(value, 'profile'),
    account: requiredString(value, 'account'),
    state: state as RecordState,
    client_id: requiredString(value, 'client_id'),
    ext_agent_host_id: requiredString(value, 'ext_agent_host_id'),
    welcomeShown,
    ...optional('subject', stringField(value, 'subject')),
    ...optional('email', stringField(value, 'email')),
    ...optional('access_token', stringField(value, 'access_token')),
    ...optional('refresh_token', stringField(value, 'refresh_token')),
    ...optional('id_token', stringField(value, 'id_token')),
    ...optional('expiresAt', numberField(value, 'expiresAt')),
    ...optional('scope', stringField(value, 'scope')),
    ...optional('earliestRefreshAt', stringField(value, 'earliestRefreshAt')),
    ...optional('generation', numberField(value, 'generation')),
    ...optional('pendingRefresh', parsePending(value['pendingRefresh'])),
    ...optional('cause', stringField(value, 'cause')),
    ...optional('interrupted', booleanField(value, 'interrupted')),
    ...optional('paused', parsePause(value['paused'])),
  };
};

const serialize = (record: PlanRecord): string => JSON.stringify(record);

const registrationOf = (record: PlanRecord): PlanRecord => ({
  version: record.version,
  profile: record.profile,
  account: record.account,
  state: 'registered',
  client_id: record.client_id,
  ext_agent_host_id: record.ext_agent_host_id,
  welcomeShown: record.welcomeShown,
  ...optional('subject', record.subject),
  ...optional('email', record.email),
  ...optional('generation', record.generation),
});

const withoutTokens = (record: PlanRecord, cause: string, interrupted: boolean): PlanRecord => {
  const { access_token: _access, refresh_token: _refresh, expiresAt: _expires, pendingRefresh: _pending, interrupted: _interrupted, ...kept } = record;
  return { ...kept, state: 'needs_sign_in', cause, ...(interrupted ? { interrupted: true } : {}) };
};

const withoutPending = (record: PlanRecord): PlanRecord => {
  const { pendingRefresh: _pending, cause: _cause, interrupted: _interrupted, ...kept } = record;
  return kept;
};

const withoutPause = (record: PlanRecord): PlanRecord => {
  const { paused: _paused, ...kept } = record;
  return kept;
};

const signingOutRecord = (record: PlanRecord): PlanRecord => ({ ...record, state: 'signing_out' });

const SELECTABLE_STATES: ReadonlySet<PlanStatus['state']> = new Set<PlanStatus['state']>(['active']);

export class PlanAccountNotSelectableError extends Error {
  readonly ref: PlanAccountRef;

  constructor(ref: PlanAccountRef) {
    super(`${ref.account} has no verified sign-in to switch to. Sign in to it first.`);
    this.name = 'PlanAccountNotSelectableError';
    this.ref = ref;
  }
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const sweepTemporaries = async (fileSystem: FileSystem, directory: string, lock: KernelLockMechanism, warn: (message: string) => void): Promise<void> => {
  await sweepLeftovers({
    directories: [{ directory, isLeftover: isAtomicWriteTemporary }],
    lock,
    warn,
    files: { readdir: (entries) => fileSystem.readdir(entries), rm: (entry) => fileSystem.rm(entry, { recursive: true }) },
  });
};

const waitFor = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error as Error);
      },
    );
  });
};

export const openPlanSessions = async (options: OpenPlanSessionsOptions): Promise<PlanSessions> => {
  const { store, fileSystem, clock, paths } = options;
  const defaults = PLAN_SESSION_DEFAULTS;
  const retry = GATEWAY_CONFIG_DEFAULTS.retry;
  const waitPolicy: WaitPolicy = { totalWaitMs: retry.totalWaitMs, baseMs: retry.baseMs, maxMs: retry.maxMs, random: options.random ?? systemRandom.float };
  const events = options.events ?? noPlanEvents;
  const activeLabels = new Map<string, string>();
  let pointerProblem: string | undefined;
  const accounts = new Map<string, Account>();
  const background = new Set<Promise<void>>();
  const backgroundFailures: unknown[] = [];
  const closing = new AbortController();
  let hostKnown = false;

  const profileOf = (id: string): PlanProfile => {
    const profile = Object.hasOwn(options.profiles, id) ? options.profiles[id] : undefined;
    if (profile === undefined) throw new Error(`unknown plan profile ${JSON.stringify(id)}`);
    return profile;
  };

  const accountOf = (profileId: string, label: string): Account => {
    const key = recordKey(profileId, label);
    const existing = accounts.get(key);
    if (existing !== undefined) return existing;
    const created: Account = {
      key,
      profile: profileOf(profileId),
      label,
      loaded: undefined,
      loading: undefined,
      dirty: false,
      unwritable: undefined,
      interrupted: false,
      inflight: undefined,
      forced: new Map(),
      persisting: false,
      resumedSignOut: undefined,
    };
    accounts.set(key, created);
    return created;
  };

  const endedAtClose = (work: Promise<void>): Promise<void> =>
    work.catch((error: unknown) => {
      if (!closing.signal.aborted || error !== closing.signal.reason) throw error;
    });

  const runInBackground = (task: Promise<void>): void => {
    const tracked = task.then(
      () => undefined,
      (error: unknown) => {
        backgroundFailures.push(error);
        options.warn(`a background plan session task failed: ${describeError(error)}`);
      },
    );
    background.add(tracked);
    void tracked.then(() => background.delete(tracked));
  };

  const loadNow = async (account: Account): Promise<void> => {
    try {
      const raw = await store.read(account.key);
      if (raw === undefined) {
        account.loaded = { kind: 'absent' };
        return;
      }
      const record = parseRecord(raw);
      adopt(account, record);
      account.interrupted = record.pendingRefresh !== undefined;
      if (record.state === 'signing_out') resumeSignOut(account);
    } catch (error) {
      const cause = describeError(error);
      account.loaded = { kind: 'unreadable', cause };
      options.warn(`the plan session of ${account.profile.id} account ${account.label} cannot be read: ${cause}`);
    }
  };

  const load = async (account: Account): Promise<void> => {
    if (account.loaded !== undefined) return;
    account.loading ??= loadNow(account);
    await account.loading;
  };

  const recordOf = (account: Account): PlanRecord | undefined => (account.loaded?.kind === 'record' ? account.loaded.record : undefined);

  const viewOf = (account: Account): AccountView => {
    const loaded = account.loaded ?? { kind: 'absent' as const };
    return loaded.kind === 'record' ? { kind: 'record', record: loaded.record, unwritable: account.unwritable } : loaded;
  };

  const adopt = (account: Account, record: PlanRecord): void => {
    for (const value of [record.access_token, record.refresh_token, record.id_token]) if (value !== undefined) options.onSecret(value);
    account.loaded = { kind: 'record', record };
  };

  const ensureHost = async (): Promise<void> => {
    if (hostKnown) return;
    try {
      await ensureHostIdentity(fileSystem, paths.host, { accountsExist: true });
    } catch (error) {
      throw hostIdentityFailure(error);
    }
    hostKnown = true;
  };

  const markWriteFailure = (account: Account, error: unknown): void => {
    account.dirty = true;
    if (isTransientErrno(error)) {
      schedulePersistRetry(account);
      return;
    }
    account.unwritable = describeError(error);
  };

  const persistAfterSend = async (account: Account, entry: CredentialEntry, record: PlanRecord): Promise<void> => {
    adopt(account, record);
    try {
      await entry.write(serialize(record));
      account.dirty = false;
    } catch (error) {
      markWriteFailure(account, error);
    }
  };

  const persistRetry = async (account: Account): Promise<void> => {
    while (account.dirty && account.unwritable === undefined && !closing.signal.aborted) {
      try {
        await options.sleep(defaults.persistRetryMs, closing.signal);
      } catch (error) {
        if (closing.signal.aborted) return;
        throw error;
      }
      await store.withKey(account.key, async (entry) => {
        const record = recordOf(account);
        if (!account.dirty || record === undefined) return;
        try {
          await entry.write(serialize(record));
          account.dirty = false;
        } catch (error) {
          if (!isTransientErrno(error)) account.unwritable = describeError(error);
        }
      });
    }
  };

  function schedulePersistRetry(account: Account): void {
    if (account.persisting) return;
    account.persisting = true;
    runInBackground(
      persistRetry(account).finally(() => {
        account.persisting = false;
      }),
    );
  }

  const refreshNeeded = (record: PlanRecord, trigger: RefreshTrigger): boolean => {
    if (record.state !== 'active' || record.refresh_token === undefined || record.expiresAt === undefined) return false;
    if (trigger.kind === 'forced') return (record.generation ?? 0) === trigger.generation;
    return record.expiresAt - clock.now() <= defaults.marginMs;
  };

  const applyRefreshEnd = async (account: Account, entry: CredentialEntry, record: PlanRecord, end: RefreshEnd, interrupted: boolean): Promise<void> => {
    if (end.kind === 'transient') return;
    if (end.kind === 'configuration') {
      await persistAfterSend(account, entry, { ...record, state: 'needs_sign_in', cause: end.code });
      return;
    }
    if (end.kind === 'terminal') {
      await persistAfterSend(account, entry, withoutTokens(record, end.code, interrupted));
      account.interrupted = false;
      return;
    }
    const { tokens } = end;
    const scope = tokens.scope;
    const replaced = tokens.refresh_token !== undefined && tokens.refresh_token !== record.refresh_token;
    const intentKept = !replaced && interrupted;
    const next: PlanRecord = {
      ...withoutPending(record),
      ...(intentKept ? optional('pendingRefresh', record.pendingRefresh) : {}),
      state: grantsScope(scope, account.profile.oauth.requiredScope) ? 'active' : 'plan_disabled',
      access_token: tokens.access_token,
      ...optional('refresh_token', tokens.refresh_token ?? record.refresh_token),
      ...optional('id_token', tokens.id_token ?? record.id_token),
      expiresAt: clock.now() + tokens.expires_in * 1000,
      scope,
      ...optional('earliestRefreshAt', tokens.earliest_refresh_at),
      generation: (record.generation ?? 0) + 1,
    };
    await persistAfterSend(account, entry, next);
    account.interrupted = intentKept;
  };

  const refreshEvent = (account: Account, end: RefreshEnd, interrupted: boolean, startedAt: number, remainingMs: number): void => {
    events('plan.refresh', {
      profile: account.profile.id,
      account: account.label,
      outcome: end.kind,
      ...(end.kind === 'terminal' || end.kind === 'configuration' ? { code: end.code } : {}),
      ...(end.kind === 'terminal' ? { interrupted } : {}),
      attempts: end.attempts,
      latencyMs: clock.now() - startedAt,
      remainingMs,
      ...(end.kind === 'adopted' && end.tokens.earliest_refresh_at !== undefined ? { earliestRefreshAt: end.tokens.earliest_refresh_at } : {}),
      at: new Date(clock.now()).toISOString(),
    });
  };

  const refreshWith = (fetch: PlanFetch, account: Account, trigger: RefreshTrigger): Promise<void> =>
    store.withKey(account.key, async (entry) => {
      const record = recordOf(account);
      if (record === undefined || account.unwritable !== undefined || !refreshNeeded(record, trigger)) return;
      const { refresh_token: refreshToken, expiresAt } = record;
      if (refreshToken === undefined || expiresAt === undefined) return;
      const startedAt = clock.now();
      const intent: PlanRecord = { ...record, pendingRefresh: { generation: record.generation ?? 0, startedAt } };
      try {
        await entry.write(serialize(intent));
      } catch (error) {
        markWriteFailure(account, error);
        return;
      }
      adopt(account, intent);
      account.dirty = false;
      const end = await sendRefresh({
        ports: { fetch, sleep: options.sleep },
        clock,
        tokenUrl: account.profile.oauth.tokenUrl,
        form: { grant_type: 'refresh_token', client_id: record.client_id, refresh_token: refreshToken, resource: account.profile.oauth.resource },
        attempts: retry.maxAttempts,
        attemptTimeoutMs: defaults.attemptTimeoutMs,
        waitPolicy,
      });
      const interrupted = (end.kind === 'terminal' || end.kind === 'adopted') && sendWasInterrupted({ intentLoaded: account.interrupted, unansweredBefore: end.unansweredBefore });
      await applyRefreshEnd(account, entry, intent, end, interrupted);
      refreshEvent(account, end, interrupted, startedAt, expiresAt - startedAt);
    });

  const refreshInScope = (account: Account, trigger: RefreshTrigger): Promise<void> =>
    endedAtClose((async (): Promise<void> => options.outbound(closing.signal, (fetch) => refreshWith(fetch, account, trigger)))());

  const refreshOnce = (account: Account, trigger: RefreshTrigger): Promise<void> => {
    if (account.inflight !== undefined) return account.inflight;
    const running = refreshInScope(account, trigger).finally(() => {
      account.inflight = undefined;
    });
    account.inflight = running;
    return running;
  };

  const usableRecord = async (account: Account): Promise<PlanRecord> => {
    const condition = blockingCondition(account.profile, viewOf(account), clock.now());
    if (condition !== undefined) throw conditionFailure(condition);
    const record = recordOf(account);
    if (record?.access_token === undefined || record.expiresAt === undefined) {
      throw conditionFailure({ reason: 'sign_in_required', code: 'sign_in_required', detail: signInRequiredMessage(account.profile, record) });
    }
    await ensureHost();
    return record;
  };

  const served = (record: PlanRecord): PlanRead => ({ bearer: record.access_token ?? '', generation: record.generation ?? 0 });

  const bearer = async (account: Account, signal: AbortSignal): Promise<PlanRead> => {
    const before = await usableRecord(account);
    const remaining = (record: PlanRecord): number => (record.expiresAt ?? 0) - clock.now();
    if (account.unwritable !== undefined) {
      if (remaining(before) > defaults.skewMs) return served(before);
      throw unwritableFailure(account.unwritable);
    }
    if (remaining(before) > defaults.marginMs) return served(before);
    await waitFor(refreshOnce(account, { kind: 'lazy' }), signal);
    const after = await usableRecord(account);
    if ((after.generation ?? 0) !== (before.generation ?? 0) || remaining(after) > defaults.marginMs) return served(after);
    if (remaining(after) > defaults.skewMs) return served(after);
    throw unavailableFailure();
  };

  const rejected = async (account: Account, generation: number, signal: AbortSignal): Promise<'renewed' | 'unchanged'> => {
    await waitFor(load(account), signal);
    const current = recordOf(account)?.generation ?? 0;
    if (generation === current && !account.forced.has(current)) account.forced.set(current, refreshOnce(account, { kind: 'forced', generation: current }));
    const pending = account.forced.get(generation);
    if (pending !== undefined) await waitFor(pending, signal);
    return (recordOf(account)?.generation ?? 0) > generation ? 'renewed' : 'unchanged';
  };

  const changeRecord = async (account: Account, change: (record: PlanRecord) => PlanRecord): Promise<void> => {
    await load(account);
    await store.withKey(account.key, async (entry) => {
      const record = recordOf(account);
      if (record === undefined) throw conditionFailure(blockingCondition(account.profile, viewOf(account), clock.now()) ?? { reason: 'sign_in_required', code: 'sign_in_required', detail: signInRequiredMessage(account.profile, undefined) });
      const next = change(record);
      await entry.write(serialize(next));
      adopt(account, next);
      account.dirty = false;
    });
  };

  const signOutWith = (fetch: PlanFetch, account: Account): Promise<SignOutReport> =>
    store.withKey(account.key, async (entry) => {
      const record = recordOf(account);
      if (record === undefined) throw conditionFailure(blockingCondition(account.profile, viewOf(account), clock.now()) ?? { reason: 'sign_in_required', code: 'sign_in_required', detail: signInRequiredMessage(account.profile, undefined) });
      const latestKnown = record.pendingRefresh === undefined;
      const signingOut = signingOutRecord(record);
      await entry.write(serialize(signingOut));
      adopt(account, signingOut);
      account.dirty = false;
      const answer: RevocationAnswer =
        record.refresh_token === undefined
          ? 'unconfirmed'
          : await revokeRefreshToken({
              ports: { fetch, sleep: options.sleep },
              clock,
              profile: account.profile,
              clientId: record.client_id,
              refreshToken: record.refresh_token,
              attempts: retry.maxAttempts,
              attemptTimeoutMs: defaults.revocationTimeoutMs,
              waitPolicy,
            });
      const cleared = registrationOf(record);
      await entry.write(serialize(cleared));
      adopt(account, cleared);
      account.unwritable = undefined;
      account.interrupted = false;
      account.forced.clear();
      return { revocation: answer === 'confirmed' && latestKnown ? 'confirmed' : 'unconfirmed', usageUrl: account.profile.usageUrl };
    });

  const runSignOut = async (account: Account, signal: AbortSignal, resumed: boolean): Promise<SignOutReport> => {
    const report = await options.outbound(signal, (fetch) => signOutWith(fetch, account));
    events('plan.sign_out', { profile: account.profile.id, account: account.label, revocation: report.revocation, resumed });
    return report;
  };

  function resumeSignOut(account: Account): void {
    const flight = runSignOut(account, closing.signal, true).finally(() => {
      account.resumedSignOut = undefined;
    });
    account.resumedSignOut = flight;
    runInBackground(endedAtClose(flight.then(() => undefined)));
  }

  const signOutAccount = async (account: Account, signal: AbortSignal): Promise<SignOutReport> => {
    await load(account);
    return account.resumedSignOut === undefined ? runSignOut(account, signal, false) : waitFor(account.resumedSignOut, signal);
  };

  const moveActive = async (ref: PlanAccountRef): Promise<void> => {
    await writeActiveAccount(fileSystem, paths.active, ref.profile, ref.account);
    activeLabels.set(ref.profile, ref.account);
  };

  const register = async (input: RegisterInput): Promise<{ outcome: 'registered' } | Rejected> => {
    const account = accountOf(input.profile, input.account);
    return store.withKey(account.key, async (entry) => {
      const raw = await entry.read();
      if (raw !== undefined) {
        const existing = parseRecord(raw);
        adopt(account, existing);
        return existing.client_id === input.clientId ? { outcome: 'registered' as const } : { outcome: 'rejected' as const, reason: 'registration_superseded' as const };
      }
      const record: PlanRecord = {
        version: RECORD_VERSION,
        profile: input.profile,
        account: input.account,
        state: 'registered',
        client_id: input.clientId,
        ext_agent_host_id: input.hostId,
        welcomeShown: false,
      };
      await entry.write(serialize(record));
      adopt(account, record);
      return { outcome: 'registered' as const };
    });
  };

  const install = async (input: InstallInput): Promise<Installed | Rejected> => {
    const account = accountOf(input.profile, input.account);
    const { tokens } = input;
    const problem = tokenResponseProblem(tokens, { refreshRequired: typeof tokens.scope === 'string' && refreshRequiredFor(tokens.scope) });
    if (problem !== undefined) throw new Error(`the sign-in installed nothing: ${problem}`);
    const outcome = await store.withKey(account.key, async (entry) => {
      const raw = await entry.read();
      const existing = raw === undefined ? undefined : parseRecord(raw);
      if (existing === undefined || existing.client_id !== input.clientId || (existing.subject !== undefined && existing.subject !== input.subject)) {
        return { outcome: 'rejected' as const, reason: 'registration_superseded' as const };
      }
      const state: RecordState = grantsScope(tokens.scope, account.profile.oauth.requiredScope) ? 'active' : 'plan_disabled';
      const firstSignIn = state === 'active' && !existing.welcomeShown;
      const record: PlanRecord = {
        version: RECORD_VERSION,
        profile: input.profile,
        account: input.account,
        state,
        client_id: existing.client_id,
        ext_agent_host_id: input.hostId,
        welcomeShown: existing.welcomeShown || firstSignIn,
        subject: input.subject,
        ...optional('email', input.email),
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        id_token: input.idToken,
        expiresAt: clock.now() + tokens.expires_in * 1000,
        scope: tokens.scope,
        ...optional('earliestRefreshAt', tokens.earliest_refresh_at),
        generation: (existing.generation ?? 0) + 1,
      };
      await entry.write(serialize(record));
      adopt(account, record);
      account.dirty = false;
      account.unwritable = undefined;
      account.interrupted = false;
      account.forced.clear();
      return { outcome: state === 'active' ? ('signed_in' as const) : ('plan_disabled' as const), firstSignIn };
    });
    if (outcome.outcome !== 'rejected') await moveActive({ profile: input.profile, account: input.account });
    return outcome;
  };

  const registration = async (ref: PlanAccountRef): Promise<Registration | undefined> => {
    const account = accountOf(ref.profile, ref.account);
    await load(account);
    if (account.loaded?.kind === 'unreadable') throw conditionFailure({ reason: 'store_unreadable', code: 'plan_store_unreadable', detail: account.loaded.cause });
    const record = recordOf(account);
    if (record === undefined) return undefined;
    return { state: record.state, clientId: record.client_id, ...optional('subject', record.subject), ...optional('email', record.email), ...optional('idToken', record.id_token) };
  };

  const known = async (): Promise<readonly KnownAccount[]> => {
    const listed = [...accounts.values()];
    await Promise.all(listed.map(load));
    return listed.flatMap((account) => (account.loaded === undefined || account.loaded.kind === 'absent' ? [] : [{ profile: account.profile.id, account: account.label, view: viewOf(account) }]));
  };

  const resume = async (ref: PlanAccountRef): Promise<boolean> => {
    const account = accountOf(ref.profile, ref.account);
    await load(account);
    if (recordOf(account)?.paused === undefined) return false;
    await changeRecord(account, withoutPause);
    return true;
  };

  const selectActive = async (ref: PlanAccountRef): Promise<void> => {
    const account = accountOf(ref.profile, ref.account);
    await load(account);
    if (!SELECTABLE_STATES.has(statusOf(viewOf(account), clock.now()).state)) throw new PlanAccountNotSelectableError(ref);
    await moveActive(ref);
  };

  const noActiveAccount = (profile: PlanProfile): PlanCredentialError =>
    pointerProblem === undefined
      ? conditionFailure({ reason: 'sign_in_required', code: 'sign_in_required', detail: signInRequiredMessage(profile, undefined) })
      : conditionFailure({ reason: 'store_unreadable', code: 'plan_store_unreadable', detail: pointerProblem });

  const signedOutSource = (profileId: string): AuthSource => {
    const profile = profileOf(profileId);
    return {
      read: async () => {
        throw noActiveAccount(profile);
      },
      rejected: async () => 'unchanged',
      pause: async () => undefined,
      resume: async () => undefined,
      status: () => statusOf({ kind: 'absent' }, clock.now()),
      health: () => healthOf(profile, undefined, { kind: 'absent' }, clock.now()),
    };
  };

  const authSource = (target: { profile: string; account?: string }): AuthSource => {
    const profile = profileOf(target.profile);
    let servedLabel = target.account;
    const resolve = async (): Promise<Account> => {
      const label = target.account ?? activeLabels.get(profile.id);
      if (label === undefined) throw noActiveAccount(profile);
      servedLabel = label;
      const account = accountOf(profile.id, label);
      await load(account);
      return account;
    };
    const servedAccount = async (): Promise<Account> => (servedLabel === undefined ? resolve() : accountOf(profile.id, servedLabel));
    const knownView = (): AccountView => (servedLabel === undefined ? { kind: 'absent' } : viewOf(accountOf(profile.id, servedLabel)));
    return {
      read: async (signal) => bearer(await waitFor(resolve(), signal), signal),
      rejected: async (generation, signal) => {
        const account = await waitFor(servedAccount(), signal);
        const answer = await rejected(account, generation, signal);
        events('plan.rejected', { profile: profile.id, account: account.label, generation, answer });
        return answer;
      },
      pause: async ({ untilMs, code }) => {
        const account = await servedAccount();
        await changeRecord(account, (record) => ({ ...record, paused: untilMs === undefined ? {} : { until: untilMs } }));
        events('plan.pause', { profile: profile.id, account: account.label, code, ...(untilMs === undefined ? {} : { until: new Date(untilMs).toISOString() }) });
      },
      resume: async () => changeRecord(await servedAccount(), withoutPause),
      status: () => statusOf(knownView(), clock.now()),
      health: () => healthOf(profile, servedLabel, knownView(), clock.now()),
    };
  };

  const serve = async (refs: readonly PlanAccountRef[]): Promise<void> => {
    await Promise.all(refs.map((ref) => load(accountOf(ref.profile, ref.account))));
  };

  await sweepTemporaries(fileSystem, paths.sessions, options.lock ?? hostKernelLock(), options.warn);
  const listing = await store.listKeys();
  const listProblems: PlanListProblem[] = [...listing.problems];
  for (const { key, file } of listing.keys) {
    const ref = refOfKey(key);
    if (ref === undefined) listProblems.push({ file, cause: `the record key ${JSON.stringify(key)} does not name a plan account` });
    else if (Object.hasOwn(options.profiles, ref.profile)) accountOf(ref.profile, ref.account);
    else options.warn(`a saved account of profile ${ref.profile} is not listed: this build ships no such profile`);
  }
  try {
    const pointer = await readActivePointer(fileSystem, paths.active);
    for (const profile of Object.keys(options.profiles)) {
      const label = Object.hasOwn(pointer, profile) ? pointer[profile] : undefined;
      if (label !== undefined) activeLabels.set(profile, label);
    }
  } catch (error) {
    pointerProblem = describeError(error);
    listProblems.push({ file: path.basename(paths.active), cause: pointerProblem });
  }
  for (const problem of listProblems) options.warn(`could not list ${problem.file}: ${problem.cause}`);
  await serve(options.accounts);

  return {
    register,
    install: async (input) => {
      const outcome = await install(input);
      if (outcome.outcome !== 'rejected') {
        const account = accountOf(input.profile, input.account);
        const record = recordOf(account);
        if (record?.paused !== undefined) adopt(account, withoutPause(record));
      }
      return outcome;
    },
    registration,
    load: (ref) => load(accountOf(ref.profile, ref.account)),
    known,
    listProblems: () => listProblems,
    resume,
    selectActive,
    signOut: (ref, signal) => signOutAccount(accountOf(ref.profile, ref.account), signal),
    authSource,
    signedOutSource,
    serve,
    activeLabel: (profile) => activeLabels.get(profile),
    lifetime: closing.signal,
    close: async () => {
      closing.abort();
      await Promise.all([...background]);
      await Promise.all([...accounts.values()].map((account) => account.inflight));
      if (backgroundFailures.length > 0) throw new AggregateError(backgroundFailures, 'plan session background tasks failed');
    },
  };
};
