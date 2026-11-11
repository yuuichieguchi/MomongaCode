import path from 'node:path';
import type { PlanProfile } from '@momonga/config';
import { HOST_READ_BOUND_MS, hostKernelLock, isAtomicWriteTemporary, isRecord, isTransientErrno, operationLimit, sweepLeftovers, systemRandom } from '@momonga/foundation';
import type { Clock, CredentialEntry, FileSystem, KernelLockMechanism, LimitTiming, ListableCredentialStore } from '@momonga/foundation';
import { PLAN_ACCOUNT_STATES, PLAN_DISABLED_STATE, PLAN_LABEL_PATTERN, PLAN_REVOCATION_CONFIRMED, PLAN_REVOCATION_NONE, PLAN_REVOCATION_UNCONFIRMED, PLAN_SIGN_IN_FAILURE, PLAN_STORE_STATES, SIGNED_IN_OUTCOME, isPlanLabel } from '@momonga/protocol';
import type { NamedPlanAccountRef, PlanAccountRef, PlanAccountState, PlanListProblem, PlanRevocation, PlanRevocationAnswer, PlanStoreState } from '@momonga/protocol';
import { GATEWAY_CONFIG_DEFAULTS, PLAN_SESSION_DEFAULTS, PLAN_SIGN_IN_DEFAULTS } from '../defaults.ts';
import { describeError } from '../core/describe-error.ts';
import type { WaitPolicy } from '../core/retry.ts';
import { readActivePointer, writeActivePointer } from './active-account.ts';
import type { ActivePointer } from './active-account.ts';
import {
  PlanCredentialError,
  blockingCondition,
  conditionFailure,
  healthOf,
  hostIdentityFailure,
  signInRequiredCondition,
  statusOf,
  unavailableFailure,
  unwritableFailure,
} from './auth-source.ts';
import type { AccountView, AuthSource, PlanPause, PlanRead, PlanStatus } from './auth-source.ts';
import { PLAN_EVENT_INTERNAL, endCodeOf, eventScalar, noPlanEvents } from './events.ts';
import type { PlanEvents } from './events.ts';
import { createGenerationFlight } from './generation-flight.ts';
import type { GenerationFlight } from './generation-flight.ts';
import { ensureHostIdentity } from './host-identity.ts';
import type { PlanOutbound } from './outbound.ts';
import { ownEntry } from './own-entry.ts';
import { parsePlanJson } from './plan-json.ts';
import { planProfileNamed } from './profiles.ts';
import { endedByOperation, recordAccess, storeReadFailure, storeWriteFailure, withRecord } from './record-io.ts';
import { grantsScope, lazyRefreshMarginMs, refreshRequiredFor, sendRefresh, sendWasInterrupted, tokenResponseProblem } from './refresh.ts';
import type { PlanFetch, PlanSleep, RefreshEnd, RefreshTokens } from './refresh.ts';
import { revokeRefreshToken } from './revoke.ts';
import { createSerial } from './serial.ts';
import { startSharedCall } from './shared-call.ts';
import type { SharedCall } from './shared-call.ts';
import type { Serial } from './serial.ts';

export type { PlanFetch, PlanSleep, PlanTokenResponse } from './refresh.ts';
export { PlanCredentialError } from './auth-source.ts';
export type { AuthSource, PlanHealth, PlanRead, PlanStatus } from './auth-source.ts';

const RECORD_VERSION = 1;

type RecordState = Exclude<PlanAccountState, PlanStoreState>;

const STORE_STATES: ReadonlySet<string> = new Set(PLAN_STORE_STATES);

const RECORD_STATES: readonly RecordState[] = PLAN_ACCOUNT_STATES.filter((state): state is RecordState => !STORE_STATES.has(state));

const recordStateOf = (state: string): RecordState | undefined => RECORD_STATES.find((known) => known === state);

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
  lifetimeMs?: number;
  scope?: string;
  earliestRefreshAt?: string;
  generation?: number;
  pendingRefresh?: { generation: number; startedAt: number };
  cause?: string;
  interrupted?: boolean;
  paused?: PlanPause;
};

export type PlanPaths = { sessions: string; host: string; active: string };

export type OpenPlanSessionsOptions = {
  profiles: Readonly<Record<string, PlanProfile>>;
  paths: PlanPaths;
  store: ListableCredentialStore;
  fileSystem: FileSystem;
  accounts: readonly NamedPlanAccountRef[];
  clock: Clock;
  outbound: PlanOutbound;
  sleep: PlanSleep;
  signal: AbortSignal;
  timing?: LimitTiming;
  redact(key: string, values: readonly string[]): void;
  warn(message: string): void;
  lock?: KernelLockMechanism;
  random?: () => number;
  events?: PlanEvents;
  pointerSerial?: Serial;
};

export type RegisterInput = { profile: string; account: string; clientId: string; hostId: string };

export type InstallInput = RegisterInput & { subject: string; email?: string; idToken: string; tokens: RefreshTokens };

export type Installed = { outcome: typeof SIGNED_IN_OUTCOME | typeof PLAN_DISABLED_STATE; firstSignIn: boolean };

export type Registration = { state: RecordState; clientId: string; subject?: string; email?: string; idToken?: string };

export type KnownAccount = { profile: string; account: string; view: AccountView };

export type Rejected = { outcome: 'rejected'; reason: typeof PLAN_SIGN_IN_FAILURE.registrationSuperseded };

export type SignOutReport = { revocation: PlanRevocation; usageUrl: string };

export type PlanSessions = {
  register(input: RegisterInput, signal: AbortSignal): Promise<{ outcome: 'registered' } | Rejected>;
  install(input: InstallInput, signal: AbortSignal): Promise<Installed | Rejected>;
  registration(ref: NamedPlanAccountRef, signal: AbortSignal): Promise<Registration | undefined>;
  load(ref: NamedPlanAccountRef, signal: AbortSignal): Promise<void>;
  known(signal: AbortSignal): Promise<readonly KnownAccount[]>;
  listProblems(): readonly PlanListProblem[];
  resume(ref: NamedPlanAccountRef, signal: AbortSignal): Promise<boolean>;
  selectActive(ref: NamedPlanAccountRef, signal: AbortSignal): Promise<void>;
  pointerReady(): Promise<void>;
  signOut(ref: NamedPlanAccountRef, signal: AbortSignal): Promise<SignOutReport>;
  authSource(target: PlanAccountRef): AuthSource;
  signedOutSource(profile: string): AuthSource;
  serve(refs: readonly NamedPlanAccountRef[], signal: AbortSignal): Promise<void>;
  activeLabel(profile: string): string | undefined;
  readonly lifetime: AbortSignal;
  close(): Promise<void>;
};

type Loaded = { kind: 'absent' } | { kind: 'unreadable'; cause: string } | { kind: 'record'; record: PlanRecord };

type ReplacedBy = 'lazy' | 'forced';

type FedRecord = { tokens: readonly string[]; access: string | undefined; accessExpiresAt: number | undefined };

type Fed = {
  current: FedRecord | undefined;
  previous: (FedRecord & { replacedBy: ReplacedBy }) | undefined;
  older: ReadonlyArray<{ value: string; expiresAt: number }>;
};

type Account = {
  key: string;
  profile: PlanProfile;
  label: string;
  loaded: Loaded | undefined;
  loading: SharedCall<void> | undefined;
  dirty: boolean;
  unwritable: string | undefined;
  fed: Fed;
  inflight: SharedCall<void> | undefined;
  forced: GenerationFlight<SharedCall<void>>;
  persisting: boolean;
  resumedSignOut: Promise<SignOutReport> | undefined;
  unloads: number;
  users: number;
};

type RecordLock = <T>(account: Account, action: (entry: CredentialEntry) => Promise<T>) => Promise<T>;

class UnloadedWhileWaiting extends Error {
  constructor() {
    super('the plan account was unloaded while the request waited for its record lock');
    this.name = 'UnloadedWhileWaiting';
  }
}

type RefreshTrigger = { kind: 'lazy' } | { kind: 'forced'; generation: number };

const PERSIST_LIMIT_LABEL = 'the persist limit';
const SIGN_OUT_LIMIT_LABEL = 'the sign-out limit';

const RECORD_KEY_PREFIX = 'plan/';

const recordKey = (profile: string, account: string): string => `${RECORD_KEY_PREFIX}${profile}/${account}`;

const refOfKey = (key: string): NamedPlanAccountRef | undefined => {
  if (!key.startsWith(RECORD_KEY_PREFIX)) return undefined;
  const rest = key.slice(RECORD_KEY_PREFIX.length);
  const separator = rest.indexOf('/');
  if (separator < 0) return undefined;
  const profile = rest.slice(0, separator);
  const account = rest.slice(separator + 1);
  return isPlanLabel(profile) && isPlanLabel(account) ? { profile, account } : undefined;
};

export const planRecordKeyOfPlaintext = (text: string): string => {
  const record = parseRecord(text);
  return recordKey(record.profile, record.account);
};

const optional = <K extends string, V>(name: K, value: V | undefined): { [P in K]?: V } => {
  const field: { [P in K]?: V } = {};
  if (value !== undefined) field[name] = value;
  return field;
};

const stringField = (source: Record<string, unknown>, name: string): string | undefined => {
  const value = ownEntry(source, name);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`the plan record field ${name} is not a string`);
  return value;
};

const numberField = (source: Record<string, unknown>, name: string): number | undefined => {
  const value = ownEntry(source, name);
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`the plan record field ${name} is not a number`);
  return value;
};

const booleanField = (source: Record<string, unknown>, name: string): boolean | undefined => {
  const value = ownEntry(source, name);
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

const labelField = (source: Record<string, unknown>, name: 'profile' | 'account'): string => {
  const value = requiredString(source, name);
  if (!isPlanLabel(value)) throw new Error(`the plan record names ${name === 'profile' ? 'a profile' : 'an account'} that does not match ${PLAN_LABEL_PATTERN}`);
  return value;
};

const parseRecord = (text: string): PlanRecord => {
  const value = parsePlanJson(text, (problem) => new Error(`the plan record ${problem}`));
  if (!isRecord(value)) throw new Error('the plan record is not a JSON object');
  const version = numberField(value, 'version');
  if (version !== RECORD_VERSION) throw new Error(`the plan record has a version this build does not read; it reads version ${RECORD_VERSION}`);
  const state = recordStateOf(requiredString(value, 'state'));
  if (state === undefined) throw new Error('the plan record has an unknown state');
  const welcomeShown = ownEntry(value, 'welcomeShown');
  if (typeof welcomeShown !== 'boolean') throw new Error('the plan record has no welcomeShown');
  return {
    version,
    profile: labelField(value, 'profile'),
    account: labelField(value, 'account'),
    state,
    client_id: requiredString(value, 'client_id'),
    ext_agent_host_id: requiredString(value, 'ext_agent_host_id'),
    welcomeShown,
    ...optional('subject', stringField(value, 'subject')),
    ...optional('email', stringField(value, 'email')),
    ...optional('access_token', stringField(value, 'access_token')),
    ...optional('refresh_token', stringField(value, 'refresh_token')),
    ...optional('id_token', stringField(value, 'id_token')),
    ...optional('expiresAt', numberField(value, 'expiresAt')),
    ...optional('lifetimeMs', numberField(value, 'lifetimeMs')),
    ...optional('scope', stringField(value, 'scope')),
    ...optional('earliestRefreshAt', stringField(value, 'earliestRefreshAt')),
    ...optional('generation', numberField(value, 'generation')),
    ...optional('pendingRefresh', parsePending(ownEntry(value, 'pendingRefresh'))),
    ...optional('cause', stringField(value, 'cause')),
    ...optional('interrupted', booleanField(value, 'interrupted')),
    ...optional('paused', parsePause(ownEntry(value, 'paused'))),
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
  const { access_token: _access, refresh_token: _refresh, expiresAt: _expires, lifetimeMs: _lifetime, pendingRefresh: _pending, interrupted: _interrupted, ...kept } = record;
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
  readonly ref: NamedPlanAccountRef;

  constructor(ref: NamedPlanAccountRef) {
    super(`${ref.account} has no verified sign-in to switch to. Sign in to it first.`);
    this.name = 'PlanAccountNotSelectableError';
    this.ref = ref;
  }
}

const tokensOf = (record: PlanRecord): string[] => [record.access_token, record.refresh_token, record.id_token].filter((value): value is string => value !== undefined);

const causeOf = (failure: unknown): unknown => (failure instanceof PlanCredentialError ? failure.cause : failure);

const sweepTemporaries = async (fileSystem: FileSystem, directory: string, lock: KernelLockMechanism, warn: (message: string) => void): Promise<void> => {
  await sweepLeftovers({
    directories: [{ directory, isLeftover: isAtomicWriteTemporary }],
    lock,
    warn,
    files: { readdir: (entries) => fileSystem.readdir(entries), rm: (entry) => fileSystem.rm(entry, { recursive: true }) },
  });
};

const waitFor = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
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
  const pointerWrites = options.pointerSerial ?? createSerial();
  const pointerFile = `the active plan account file ${paths.active}`;
  const activeLabels = new Map<string, string>();
  let pointerProblem: string | undefined;
  const accounts = new Map<string, Account>();
  const background = new Set<Promise<void>>();
  const refreshes = new Set<Promise<void>>();
  const loads = new Set<Promise<void>>();
  const backgroundFailures: unknown[] = [];
  const closing = new AbortController();
  let hostKnown = false;

  const profileOf = (id: string): PlanProfile => planProfileNamed(options.profiles, id);

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
      fed: { current: undefined, previous: undefined, older: [] },
      inflight: undefined,
      forced: createGenerationFlight(),
      persisting: false,
      resumedSignOut: undefined,
      unloads: 0,
      users: 0,
    };
    accounts.set(key, created);
    return created;
  };

  const held = async <T>(account: Account, operation: (account: Account) => Promise<T>): Promise<T> => {
    account.users += 1;
    try {
      return await operation(account);
    } finally {
      account.users -= 1;
      if (account.users === 0 && account.loaded?.kind === 'absent' && accounts.get(account.key) === account) accounts.delete(account.key);
    }
  };

  const forAccount = <T>(ref: NamedPlanAccountRef, operation: (account: Account) => Promise<T>): Promise<T> => held(accountOf(ref.profile, ref.account), operation);

  const sessionOf = (account: Account): string => `the plan session of ${account.profile.id} account ${account.label}`;

  const identityOf = (account: Account): { profile: string; account: string } => ({ profile: account.profile.id, account: account.label });

  const endedByLifetime = (error: unknown): boolean => closing.signal.aborted && error === closing.signal.reason;

  const endedAtClose = (work: Promise<void>): Promise<void> =>
    work.catch((error: unknown) => {
      if (!endedByLifetime(error)) throw error;
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

  const readRecordOf = (account: Account, read: () => Promise<string | undefined>, signal: AbortSignal): Promise<PlanRecord | undefined> =>
    recordAccess(
      'read',
      sessionOf(account),
      async () => {
        const raw = await read();
        return raw === undefined ? undefined : parseRecord(raw);
      },
      signal,
    );

  const writeRecord = (account: Account, entry: CredentialEntry, record: PlanRecord, signal: AbortSignal): Promise<void> =>
    recordAccess('write', sessionOf(account), () => entry.write(serialize(record)), signal);

  const lockedRecord =
    (signal: AbortSignal): RecordLock =>
    (account, action) =>
      withRecord(store, account.key, sessionOf(account), action, signal);

  const lockedSinceLoad =
    (signal: AbortSignal): RecordLock =>
    (account, action) => {
      const unloads = account.unloads;
      return lockedRecord(signal)(account, async (entry) => {
        if (account.unloads !== unloads) throw new UnloadedWhileWaiting();
        return action(entry);
      });
    };

  const asAfterLoad = async <T>(account: Account, signal: AbortSignal, operation: (locked: RecordLock) => Promise<T>): Promise<T> => {
    try {
      return await operation(lockedSinceLoad(signal));
    } catch (error) {
      if (!(error instanceof UnloadedWhileWaiting)) throw error;
    }
    await load(account, signal);
    return operation(lockedRecord(signal));
  };

  const loadNow = async (account: Account, signal: AbortSignal): Promise<void> => {
    try {
      const record = await readRecordOf(account, () => store.read(account.key, signal), signal);
      signal.throwIfAborted();
      if (record === undefined) {
        account.loaded = { kind: 'absent' };
        return;
      }
      adopt(account, record, 'lazy');
      if (record.state === 'signing_out') resumeSignOut(account);
    } catch (error) {
      if (endedByOperation(error, signal)) throw error;
      const cause = describeError(causeOf(error));
      account.loaded = { kind: 'unreadable', cause };
      options.warn(`${sessionOf(account)} cannot be read: ${cause}`);
    }
  };

  const load = (account: Account, signal: AbortSignal): Promise<void> => {
    if (account.loaded !== undefined) return Promise.resolve();
    if (account.loading === undefined) {
      const forget = (): void => {
        if (account.loading === flight) account.loading = undefined;
      };
      const flight: SharedCall<void> = startSharedCall(
        closing.signal,
        async (shared) => {
          try {
            await loadNow(account, shared);
          } catch (error) {
            forget();
            throw error;
          }
        },
        forget,
      );
      account.loading = flight;
      const ended = flight.work.then(
        () => undefined,
        () => undefined,
      );
      loads.add(ended);
      void ended.then(() => loads.delete(ended));
    }
    return account.loading.join(signal);
  };

  const recordOf = (account: Account): PlanRecord | undefined => (account.loaded?.kind === 'record' ? account.loaded.record : undefined);

  const viewOf = (account: Account): AccountView => {
    const loaded = account.loaded ?? { kind: 'absent' as const };
    return loaded.kind === 'record' ? { kind: 'record', record: loaded.record, unwritable: account.unwritable } : loaded;
  };

  const feedRedactor = (account: Account, record: PlanRecord, replacedBy: ReplacedBy): void => {
    const tokens = tokensOf(record);
    const { current, previous, older } = account.fed;
    if (tokens.every((token) => current?.tokens.includes(token) === true)) return;
    const nowMs = clock.now();
    const leaving =
      previous !== undefined && previous.replacedBy === 'lazy' && previous.access !== undefined && previous.accessExpiresAt !== undefined
        ? [{ value: previous.access, expiresAt: previous.accessExpiresAt }]
        : [];
    const kept = [...older, ...leaving].filter((entry) => nowMs < entry.expiresAt).slice(-defaults.replacedAccessTokensKept);
    account.fed = {
      current: { tokens, access: record.access_token, accessExpiresAt: record.expiresAt },
      previous: current === undefined ? undefined : { ...current, replacedBy },
      older: kept,
    };
    options.redact(account.key, [...tokens, ...(current?.tokens ?? []), ...kept.map((entry) => entry.value)]);
  };

  const adopt = (account: Account, record: PlanRecord, replacedBy: ReplacedBy): void => {
    feedRedactor(account, record, replacedBy);
    account.forced.keepFor(record.generation ?? 0);
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

  const markWriteFailure = (account: Account, failure: unknown, signal: AbortSignal): void => {
    account.dirty = true;
    const cause = causeOf(failure);
    if (endedByOperation(failure, signal) || isTransientErrno(cause)) {
      schedulePersistRetry(account);
      return;
    }
    account.unwritable = describeError(cause);
  };

  const persistAfterSend = async (account: Account, entry: CredentialEntry, record: PlanRecord, replacedBy: ReplacedBy, signal: AbortSignal): Promise<boolean> => {
    adopt(account, record, replacedBy);
    try {
      await writeRecord(account, entry, record, signal);
      account.dirty = false;
      return true;
    } catch (error) {
      markWriteFailure(account, error, signal);
      return false;
    }
  };

  const persistAttempt = async (account: Account): Promise<void> => {
    const limit = operationLimit(closing.signal, HOST_READ_BOUND_MS, PERSIST_LIMIT_LABEL, options.timing);
    try {
      await asAfterLoad(account, limit.signal, (locked) =>
        locked(account, async (entry) => {
          const record = recordOf(account);
          if (!account.dirty || record === undefined) return;
          try {
            await writeRecord(account, entry, record, limit.signal);
            account.dirty = false;
          } catch (error) {
            if (endedByOperation(error, limit.signal)) throw error;
            const cause = causeOf(error);
            if (!isTransientErrno(cause)) account.unwritable = describeError(cause);
          }
        }),
      );
    } catch (error) {
      if (!endedByOperation(error, limit.signal)) throw error;
    } finally {
      limit.dispose();
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
      await persistAttempt(account);
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

  const lazyMarginOf = (record: PlanRecord): number => (record.lifetimeMs === undefined ? defaults.marginMs : lazyRefreshMarginMs(record.lifetimeMs));

  const refreshNeeded = (record: PlanRecord, trigger: RefreshTrigger): boolean => {
    if (record.state !== 'active' || record.refresh_token === undefined || record.expiresAt === undefined) return false;
    if (record.lifetimeMs !== undefined && clock.now() - (record.expiresAt - record.lifetimeMs) < defaults.skewMs) return false;
    if (trigger.kind === 'forced') return (record.generation ?? 0) === trigger.generation;
    return record.expiresAt - clock.now() <= lazyMarginOf(record);
  };

  type RefreshWrite = { account: Account; entry: CredentialEntry; record: PlanRecord; replacedBy: ReplacedBy; signal: AbortSignal };

  const applyRefreshEnd = async ({ account, entry, record, replacedBy, signal }: RefreshWrite, end: RefreshEnd, interrupted: boolean): Promise<void> => {
    if (end.kind === 'transient') return;
    if (end.kind === 'configuration') {
      await persistAfterSend(account, entry, { ...record, state: 'needs_sign_in', cause: end.code }, replacedBy, signal);
      return;
    }
    if (end.kind === 'terminal') {
      await persistAfterSend(account, entry, withoutTokens(record, end.code, interrupted), replacedBy, signal);
      return;
    }
    const { tokens } = end;
    const scope = tokens.scope;
    const replaced = tokens.refresh_token !== undefined && tokens.refresh_token !== record.refresh_token;
    const intentKept = !replaced && interrupted;
    const lifetimeMs = tokens.expires_in * 1000;
    const next: PlanRecord = {
      ...withoutPending(record),
      ...(intentKept ? optional('pendingRefresh', record.pendingRefresh) : {}),
      state: grantsScope(scope, account.profile.oauth.requiredScope) ? 'active' : PLAN_DISABLED_STATE,
      access_token: tokens.access_token,
      ...optional('refresh_token', tokens.refresh_token ?? record.refresh_token),
      ...optional('id_token', tokens.id_token ?? record.id_token),
      expiresAt: clock.now() + lifetimeMs,
      lifetimeMs,
      scope,
      ...optional('earliestRefreshAt', tokens.earliest_refresh_at),
      generation: (record.generation ?? 0) + 1,
    };
    await persistAfterSend(account, entry, next, replacedBy, signal);
  };

  const refreshTiming = (startedAt: number, remainingMs: number): { latencyMs: number; remainingMs: number; at: string } => ({
    latencyMs: clock.now() - startedAt,
    remainingMs,
    at: new Date(clock.now()).toISOString(),
  });

  const refreshEvent = (account: Account, end: RefreshEnd, interrupted: boolean, startedAt: number, remainingMs: number): void => {
    const { latencyMs, at } = refreshTiming(startedAt, remainingMs);
    events('plan.refresh', {
      ...identityOf(account),
      outcome: end.kind,
      ...(end.kind === 'terminal' || end.kind === 'configuration' ? { code: eventScalar(end.code) } : {}),
      ...(end.kind === 'terminal' ? { interrupted } : {}),
      attempts: end.attempts,
      latencyMs,
      remainingMs,
      ...(end.kind === 'adopted' && end.tokens.earliest_refresh_at !== undefined ? { earliestRefreshAt: eventScalar(end.tokens.earliest_refresh_at) } : {}),
      at,
    });
  };

  const refreshFailedEvent = (account: Account, failure: unknown, attempts: number, startedAt: number, remainingMs: number): void => {
    events('plan.refresh', { ...identityOf(account), outcome: 'failed', code: endCodeOf(failure), attempts, ...refreshTiming(startedAt, remainingMs) });
  };

  const refreshUnderLock = (fetch: PlanFetch, account: Account, trigger: RefreshTrigger, locked: RecordLock, signal: AbortSignal): Promise<void> =>
    locked(account, async (entry) => {
      const record = recordOf(account);
      if (record === undefined || account.unwritable !== undefined || !refreshNeeded(record, trigger)) return;
      const { refresh_token: refreshToken, expiresAt } = record;
      if (refreshToken === undefined || expiresAt === undefined) return;
      const startedAt = clock.now();
      const remainingMs = expiresAt - startedAt;
      const intentLoaded = record.pendingRefresh !== undefined;
      const intent: PlanRecord = { ...record, pendingRefresh: { generation: record.generation ?? 0, startedAt } };
      try {
        await writeRecord(account, entry, intent, signal);
      } catch (error) {
        markWriteFailure(account, error, signal);
        refreshFailedEvent(account, error, 0, startedAt, remainingMs);
        return;
      }
      adopt(account, intent, 'lazy');
      account.dirty = false;
      let attempts = 0;
      let finished: { end: RefreshEnd; interrupted: boolean };
      try {
        const end = await sendRefresh({
          ports: { fetch, sleep: options.sleep },
          clock,
          tokenUrl: account.profile.oauth.tokenUrl,
          form: { grant_type: 'refresh_token', client_id: record.client_id, refresh_token: refreshToken, resource: account.profile.oauth.resource },
          attempts: retry.maxAttempts,
          attemptTimeoutMs: defaults.attemptTimeoutMs,
          waitPolicy,
          maxBodyBytes: PLAN_SIGN_IN_DEFAULTS.authBodyBytes,
          signal,
        });
        attempts = end.attempts;
        const interrupted = (end.kind === 'terminal' || end.kind === 'adopted') && sendWasInterrupted({ intentLoaded, unansweredBefore: end.unansweredBefore });
        await applyRefreshEnd({ account, entry, record: intent, replacedBy: trigger.kind, signal }, end, interrupted);
        finished = { end, interrupted };
      } catch (error) {
        refreshFailedEvent(account, error, attempts, startedAt, remainingMs);
        throw error;
      }
      refreshEvent(account, finished.end, finished.interrupted, startedAt, remainingMs);
    });

  const refreshWith = (fetch: PlanFetch, account: Account, trigger: RefreshTrigger, signal: AbortSignal): Promise<void> =>
    asAfterLoad(account, signal, (locked) => refreshUnderLock(fetch, account, trigger, locked, signal));

  const refreshInScope = (account: Account, trigger: RefreshTrigger, signal: AbortSignal): Promise<void> =>
    endedAtClose((async (): Promise<void> => options.outbound(signal, (fetch) => refreshWith(fetch, account, trigger, signal)))());

  const refreshOnce = (account: Account, trigger: RefreshTrigger): SharedCall<void> => {
    if (account.inflight !== undefined) return account.inflight;
    const flight: { abandoned: boolean; waiting: number } = { abandoned: false, waiting: 0 };
    const finished = (): void => {
      if (account.inflight === running) account.inflight = undefined;
    };
    const shared: SharedCall<void> = startSharedCall(
      closing.signal,
      (signal) => refreshInScope(account, trigger, signal).finally(finished),
      () => {
        flight.abandoned = true;
        finished();
        account.forced.abandon(running);
      },
    );
    const running: SharedCall<void> = {
      work: shared.work,
      join: (signal) => {
        flight.waiting += 1;
        const left = (): void => {
          flight.waiting -= 1;
        };
        signal.addEventListener('abort', left, { once: true });
        return shared.join(signal).finally(() => signal.removeEventListener('abort', left));
      },
    };
    account.inflight = running;
    const tracked = shared.work.catch((error: unknown) => {
      const receivedByAWaiter = flight.waiting > 0;
      if (!flight.abandoned && !receivedByAWaiter) throw error;
    });
    refreshes.add(tracked);
    const untrack = (): void => void refreshes.delete(tracked);
    tracked.then(untrack, untrack);
    return running;
  };

  const usableRecord = async (account: Account): Promise<PlanRecord> => {
    const condition = blockingCondition(account.profile, viewOf(account), clock.now());
    if (condition !== undefined) throw conditionFailure(condition);
    const record = recordOf(account);
    if (record?.access_token === undefined || record.expiresAt === undefined) throw conditionFailure(signInRequiredCondition(account.profile, record));
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
    if (remaining(before) > lazyMarginOf(before)) return served(before);
    await refreshOnce(account, { kind: 'lazy' }).join(signal);
    const after = await usableRecord(account);
    if ((after.generation ?? 0) !== (before.generation ?? 0) || remaining(after) > lazyMarginOf(after)) return served(after);
    if (remaining(after) > defaults.skewMs) return served(after);
    throw unavailableFailure();
  };

  const rejected = async (account: Account, generation: number, signal: AbortSignal): Promise<'renewed' | 'unchanged'> => {
    await load(account, signal);
    const record = recordOf(account);
    const current = record?.generation ?? 0;
    const trigger: RefreshTrigger = { kind: 'forced', generation: current };
    if (generation === current && account.forced.at(current) === undefined && record !== undefined && refreshNeeded(record, trigger)) account.forced.start(current, refreshOnce(account, trigger));
    const pending = account.forced.at(generation);
    if (pending !== undefined) await pending.join(signal);
    return (recordOf(account)?.generation ?? 0) > generation ? 'renewed' : 'unchanged';
  };

  const applyChange = async (account: Account, change: (record: PlanRecord) => PlanRecord, signal: AbortSignal): Promise<{ record: PlanRecord; saved: boolean } | undefined> => {
    await load(account, signal);
    return asAfterLoad(account, signal, (locked) =>
      locked(account, async (entry) => {
        const record = recordOf(account);
        if (record === undefined) return undefined;
        const next = change(record);
        return { record: next, saved: await persistAfterSend(account, entry, next, 'lazy', signal) };
      }),
    );
  };

  type SignOutProgress = { underLock: boolean; changed: boolean; revocation: PlanRevocation };

  const unloadForResume = (account: Account): void => {
    account.loaded = undefined;
    account.loading = undefined;
    account.resumedSignOut = undefined;
    account.unloads += 1;
  };

  const unloadUnfinishedSignOut = (account: Account): void => {
    if (recordOf(account)?.state === 'signing_out') unloadForResume(account);
  };

  const signOutUnderLock = async (fetch: PlanFetch, account: Account, progress: SignOutProgress, entry: CredentialEntry, signal: AbortSignal): Promise<SignOutReport> => {
    const record = recordOf(account);
    if (record === undefined) throw conditionFailure(blockingCondition(account.profile, viewOf(account), clock.now()) ?? signInRequiredCondition(account.profile, undefined));
    if (record.state === 'registered') return { revocation: PLAN_REVOCATION_NONE, usageUrl: account.profile.usageUrl };
    const latestKnown = record.pendingRefresh === undefined;
    const signingOut = signingOutRecord(record);
    progress.changed = true;
    await writeRecord(account, entry, signingOut, signal);
    adopt(account, signingOut, 'lazy');
    account.dirty = false;
    const answer: PlanRevocationAnswer =
      record.refresh_token === undefined
        ? PLAN_REVOCATION_UNCONFIRMED
        : await revokeRefreshToken({
            ports: { fetch, sleep: options.sleep },
            clock,
            profile: account.profile,
            clientId: record.client_id,
            refreshToken: record.refresh_token,
            attempts: retry.maxAttempts,
            attemptTimeoutMs: defaults.revocationTimeoutMs,
            waitPolicy,
            maxBodyBytes: PLAN_SIGN_IN_DEFAULTS.authBodyBytes,
            signal: closing.signal,
          });
    const revocation: PlanRevocationAnswer = answer === PLAN_REVOCATION_CONFIRMED && latestKnown ? PLAN_REVOCATION_CONFIRMED : PLAN_REVOCATION_UNCONFIRMED;
    progress.revocation = revocation;
    const cleared = registrationOf(record);
    await writeRecord(account, entry, cleared, signal);
    adopt(account, cleared, 'lazy');
    account.unwritable = undefined;
    account.forced.clear();
    return { revocation, usageUrl: account.profile.usageUrl };
  };

  const signOutWith = (fetch: PlanFetch, account: Account, progress: SignOutProgress, locked: RecordLock, signal: AbortSignal): Promise<SignOutReport> =>
    locked(account, async (entry) => {
      progress.underLock = true;
      try {
        return await signOutUnderLock(fetch, account, progress, entry, signal);
      } catch (error) {
        unloadUnfinishedSignOut(account);
        throw error;
      }
    });

  const runSignOut = async (account: Account, signal: AbortSignal, resumed: boolean, locked: RecordLock): Promise<SignOutReport> => {
    const progress: SignOutProgress = { underLock: false, changed: false, revocation: PLAN_REVOCATION_NONE };
    try {
      const report = await options.outbound(signal, (fetch) => signOutWith(fetch, account, progress, locked, signal));
      if (progress.changed) events('plan.sign_out', { ...identityOf(account), resumed, end: 'cleared', revocation: report.revocation });
      return report;
    } catch (error) {
      if (error instanceof UnloadedWhileWaiting) throw error;
      if (!progress.underLock) unloadUnfinishedSignOut(account);
      if (!progress.changed || endedByLifetime(error)) {
        if (progress.changed || resumed) events('plan.sign_out', { ...identityOf(account), resumed, end: 'interrupted', revocation: PLAN_REVOCATION_NONE });
      } else {
        events('plan.sign_out', { ...identityOf(account), resumed, end: 'failed', revocation: progress.revocation, code: endCodeOf(error) });
      }
      throw error;
    }
  };

  function resumeSignOut(account: Account): void {
    const limit = operationLimit(closing.signal, HOST_READ_BOUND_MS, SIGN_OUT_LIMIT_LABEL, options.timing);
    const flight = runSignOut(account, limit.signal, true, lockedRecord(limit.signal)).finally(() => limit.dispose());
    account.resumedSignOut = flight;
    runInBackground(
      flight
        .then(
          () => undefined,
          (error: unknown) => {
            if (!endedByLifetime(error)) options.warn(`the sign-out of ${account.profile.id} account ${account.label} did not finish: ${describeError(error)}; it is resumed at the next load`);
          },
        )
        .finally(() => {
          if (account.resumedSignOut === flight) account.resumedSignOut = undefined;
        }),
    );
  }

  const signOutAccount = async (account: Account, signal: AbortSignal): Promise<SignOutReport> => {
    await load(account, signal);
    return asAfterLoad(account, signal, (locked) => (account.resumedSignOut === undefined ? runSignOut(account, signal, false, locked) : waitFor(account.resumedSignOut, signal)));
  };

  const adoptPointer = (pointer: ActivePointer): void => {
    for (const [profile, label] of Object.entries(pointer)) activeLabels.set(profile, label);
    pointerProblem = undefined;
  };

  const heal = async (): Promise<void> => {
    if (pointerProblem === undefined) return;
    try {
      adoptPointer(await readActivePointer(fileSystem, paths.active));
    } catch (error) {
      pointerProblem = describeError(error);
      throw storeReadFailure(pointerProblem, error);
    }
  };

  const moveActive = (ref: NamedPlanAccountRef): Promise<void> =>
    pointerWrites.run(async () => {
      await heal();
      const next: ActivePointer = { ...Object.fromEntries(activeLabels), [ref.profile]: ref.account };
      try {
        await writeActivePointer(fileSystem, paths.active, next);
      } catch (error) {
        throw storeWriteFailure(pointerFile, error);
      }
      adoptPointer(next);
    });

  const pointerReady = async (): Promise<void> => {
    if (pointerProblem === undefined) return;
    await pointerWrites.run(heal);
  };

  const register = (input: RegisterInput, signal: AbortSignal): Promise<{ outcome: 'registered' } | Rejected> =>
    forAccount(input, (account) => registerAccount(account, input, signal));

  const registerAccount = (account: Account, input: RegisterInput, signal: AbortSignal): Promise<{ outcome: 'registered' } | Rejected> =>
    asAfterLoad(account, signal, (locked) =>
      locked(account, async (entry) => {
        const existing = await readRecordOf(account, () => entry.read(), signal);
        if (existing !== undefined) {
          adopt(account, existing, 'lazy');
          return existing.client_id === input.clientId ? { outcome: 'registered' as const } : { outcome: 'rejected' as const, reason: PLAN_SIGN_IN_FAILURE.registrationSuperseded };
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
        await writeRecord(account, entry, record, signal);
        adopt(account, record, 'lazy');
        return { outcome: 'registered' as const };
      }),
    );

  const install = (input: InstallInput, signal: AbortSignal): Promise<Installed | Rejected> => forAccount(input, (account) => installAccount(account, input, signal));

  const installAccount = async (account: Account, input: InstallInput, signal: AbortSignal): Promise<Installed | Rejected> => {
    const { tokens } = input;
    const problem = tokenResponseProblem(tokens, { refreshRequired: typeof tokens.scope === 'string' && refreshRequiredFor(tokens.scope) });
    if (problem !== undefined) throw new Error(`the sign-in installed nothing: ${problem}`);
    const outcome = await asAfterLoad(account, signal, (locked) =>
      locked(account, async (entry) => {
        const existing = await readRecordOf(account, () => entry.read(), signal);
        if (existing === undefined || existing.client_id !== input.clientId || (existing.subject !== undefined && existing.subject !== input.subject)) {
          return { outcome: 'rejected' as const, reason: PLAN_SIGN_IN_FAILURE.registrationSuperseded };
        }
        const state: RecordState = grantsScope(tokens.scope, account.profile.oauth.requiredScope) ? 'active' : PLAN_DISABLED_STATE;
        const firstSignIn = state === 'active' && !existing.welcomeShown;
        const lifetimeMs = tokens.expires_in * 1000;
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
          ...optional('refresh_token', tokens.refresh_token),
          id_token: input.idToken,
          expiresAt: clock.now() + lifetimeMs,
          lifetimeMs,
          scope: tokens.scope,
          ...optional('earliestRefreshAt', tokens.earliest_refresh_at),
          generation: (existing.generation ?? 0) + 1,
        };
        await writeRecord(account, entry, record, signal);
        adopt(account, record, 'lazy');
        account.dirty = false;
        account.unwritable = undefined;
        account.forced.clear();
        return { outcome: state === 'active' ? SIGNED_IN_OUTCOME : PLAN_DISABLED_STATE, firstSignIn };
      }),
    );
    if (outcome.outcome === 'rejected') return outcome;
    await moveActive({ profile: input.profile, account: input.account });
    const record = recordOf(account);
    if (record?.paused !== undefined) adopt(account, withoutPause(record), 'lazy');
    return outcome;
  };

  const registration = (ref: NamedPlanAccountRef, signal: AbortSignal): Promise<Registration | undefined> => forAccount(ref, (account) => registrationOfAccount(account, signal));

  const registrationOfAccount = async (account: Account, signal: AbortSignal): Promise<Registration | undefined> => {
    await load(account, signal);
    if (account.loaded?.kind === 'unreadable') throw storeReadFailure(account.loaded.cause, undefined);
    const record = recordOf(account);
    if (record === undefined) return undefined;
    return { state: record.state, clientId: record.client_id, ...optional('subject', record.subject), ...optional('email', record.email), ...optional('idToken', record.id_token) };
  };

  const known = async (signal: AbortSignal): Promise<readonly KnownAccount[]> => {
    const listed = [...accounts.values()];
    const views = await Promise.all(
      listed.map((listedAccount) =>
        held(listedAccount, async (account): Promise<KnownAccount[]> => {
          await load(account, signal);
          return account.loaded === undefined || account.loaded.kind === 'absent' ? [] : [{ profile: account.profile.id, account: account.label, view: viewOf(account) }];
        }),
      ),
    );
    return views.flat();
  };

  const resume = (ref: NamedPlanAccountRef, signal: AbortSignal): Promise<boolean> =>
    forAccount(ref, async (account) => {
      await load(account, signal);
      if (recordOf(account)?.paused === undefined) return false;
      return (await applyChange(account, withoutPause, signal)) !== undefined;
    });

  const selectActive = (ref: NamedPlanAccountRef, signal: AbortSignal): Promise<void> =>
    forAccount(ref, async (account) => {
      await load(account, signal);
      if (!SELECTABLE_STATES.has(statusOf(viewOf(account), clock.now()).state)) throw new PlanAccountNotSelectableError(ref);
      await moveActive(ref);
    });

  const unpinnedView = (): AccountView => (pointerProblem === undefined ? { kind: 'absent' } : { kind: 'unreadable', cause: pointerProblem });

  const noActiveAccount = (profile: PlanProfile): PlanCredentialError =>
    conditionFailure(blockingCondition(profile, unpinnedView(), clock.now()) ?? signInRequiredCondition(profile, undefined));

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
      health: () => healthOf(profile, undefined, unpinnedView(), clock.now()),
      resolvedAccount: () => ({ profile: profile.id }),
    };
  };

  const authSource = (target: PlanAccountRef): AuthSource => {
    const profile = profileOf(target.profile);
    let servedLabel = target.account;
    const resolved = (): Account => {
      const label = target.account ?? activeLabels.get(profile.id);
      if (label === undefined) throw noActiveAccount(profile);
      servedLabel = label;
      return accountOf(profile.id, label);
    };
    const served = (): Account => (servedLabel === undefined ? resolved() : accountOf(profile.id, servedLabel));
    const viewOfLabel = (label: string): AccountView => {
      const account = accounts.get(recordKey(profile.id, label));
      return account === undefined ? { kind: 'absent' } : viewOf(account);
    };
    const statusView = (): AccountView => (servedLabel === undefined ? { kind: 'absent' } : viewOfLabel(servedLabel));
    const healthView = (): AccountView => (servedLabel === undefined ? unpinnedView() : viewOfLabel(servedLabel));
    return {
      read: async (signal) =>
        held(resolved(), async (account) => {
          await load(account, signal);
          return bearer(account, signal);
        }),
      rejected: async (generation, signal) =>
        held(served(), async (account) => {
          const rejection = { ...identityOf(account), generation };
          try {
            const answer = await rejected(account, generation, signal);
            events('plan.rejected', { ...rejection, answer });
            return answer;
          } catch (error) {
            events('plan.rejected', { ...rejection, answer: signal.aborted && error === signal.reason ? 'aborted' : PLAN_EVENT_INTERNAL });
            throw error;
          }
        }),
      pause: async ({ untilMs, code }, signal) =>
        held(served(), async (account) => {
          const changed = await applyChange(account, (record) => ({ ...record, paused: untilMs === undefined ? {} : { until: untilMs } }), signal);
          if (changed === undefined) return;
          events('plan.pause', { ...identityOf(account), code, saved: changed.saved, ...(untilMs === undefined ? {} : { until: new Date(untilMs).toISOString() }) });
        }),
      resume: async (signal) =>
        held(served(), async (account) => {
          await applyChange(account, withoutPause, signal);
        }),
      status: () => statusOf(statusView(), clock.now()),
      health: () => healthOf(profile, servedLabel, healthView(), clock.now()),
      resolvedAccount: () => (servedLabel === undefined ? { profile: profile.id } : { profile: profile.id, account: servedLabel }),
    };
  };

  const serve = async (refs: readonly NamedPlanAccountRef[], signal: AbortSignal): Promise<void> => {
    await Promise.all(refs.map((ref) => forAccount(ref, (account) => load(account, signal))));
  };

  await sweepTemporaries(fileSystem, paths.sessions, options.lock ?? hostKernelLock(), options.warn);
  const listing = await store.listKeys(options.signal);
  const recordProblems: PlanListProblem[] = [...listing.problems];
  const listProblems = (): readonly PlanListProblem[] => (pointerProblem === undefined ? recordProblems : [...recordProblems, { file: path.basename(paths.active), cause: pointerProblem }]);
  for (const { key, file } of listing.keys) {
    const ref = refOfKey(key);
    if (ref === undefined) recordProblems.push({ file, cause: 'the record key does not name a plan account' });
    else if (Object.hasOwn(options.profiles, ref.profile)) accountOf(ref.profile, ref.account);
    else options.warn(`a saved account of profile ${ref.profile} is not listed: this build ships no such profile`);
  }
  try {
    adoptPointer(await readActivePointer(fileSystem, paths.active));
  } catch (error) {
    pointerProblem = describeError(error);
  }
  for (const problem of listProblems()) options.warn(`could not list ${problem.file}: ${problem.cause}`);
  await serve(options.accounts, options.signal);

  return {
    register,
    install,
    registration,
    load: (ref, signal) => forAccount(ref, (account) => load(account, signal)),
    known,
    listProblems,
    resume,
    selectActive,
    pointerReady,
    signOut: (ref, signal) => forAccount(ref, (account) => signOutAccount(account, signal)),
    authSource,
    signedOutSource,
    serve,
    activeLabel: (profile) => activeLabels.get(profile),
    lifetime: closing.signal,
    close: async () => {
      closing.abort();
      await Promise.all([...background, ...loads]);
      const refreshEnds = await Promise.allSettled([...refreshes]);
      const undelivered = [...backgroundFailures.splice(0), ...refreshEnds.flatMap((end): unknown[] => (end.status === 'rejected' ? [end.reason] : []))];
      if (undelivered.length > 0) throw new AggregateError(undelivered, 'plan session background tasks failed');
    },
  };
};
