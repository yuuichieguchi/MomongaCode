import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planProfileOf } from '@momonga/config';
import type { PlanProfile } from '@momonga/config';
import { CredentialStoreError, createEncryptedCredentialStore, momongaLayout, nodeFileSystem } from '@momonga/foundation';
import type { FileSystem, KernelLockMechanism, ListableCredentialStore } from '@momonga/foundation';
import { SIWC_RESOURCE, createFakeClock, siwcBrowse, startFakeSiwcAuth } from '@momonga/testkit';
import type { FakeClock, SiwcAuth } from '@momonga/testkit';
import { ensureHostIdentity } from '../src/plan/host-identity.ts';
import { openPlanSessions, planRecordKeyOfPlaintext } from '../src/plan/session.ts';
import type { PlanSessions, PlanSleep, PlanTokenResponse } from '../src/plan/session.ts';
import type { PlanFetch } from '../src/plan/refresh.ts';
import { createSerial } from '../src/plan/serial.ts';
import type { Serial } from '../src/plan/serial.ts';

export const START_MS = 1_800_000_000_000;
export const PROFILE_ID = 'chatgpt';
export const SECOND = 1000;
export const ACCESS_LIFETIME_MS = 3600 * SECOND;
export const SKEW_MS = 60 * SECOND;
export const MARGIN_MS = 121 * SECOND;
export const CONDITION_WAIT = { timeout: 30_000, interval: 5 } as const;
export const PAUSE_CODE = 'plan_usage_limit';

export const realSleep: PlanSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

export type RecordedPlanEvent = { name: string; data: Record<string, unknown> };

export type TokenFetch = (url: string, init: RequestInit) => Promise<Response>;

export type Gate = { held: Promise<void>; release(): void };

export type ReachedGate = Gate & { reached: Promise<void> };

export type FsGate = { reached: Promise<void>; release(): void; fail(error: Error): void };

export type GatedMethod = 'readTextFile' | 'readOwnerOnlyTextFile' | 'mkdirPrivate' | 'rename';

export type GatedFileSystem = { fileSystem: FileSystem; recorded: ReadonlyArray<{ method: GatedMethod; path: string }>; gate(method: GatedMethod, match: (path: string) => boolean): FsGate };

type ArmedGate = { method: GatedMethod; match: (path: string) => boolean; arrive(): void; parked: Promise<void> };

export const createGatedFileSystem = (base: FileSystem): GatedFileSystem => {
  const armed: ArmedGate[] = [];
  const recorded: Array<{ method: GatedMethod; path: string }> = [];
  const parkIfArmed = async (method: GatedMethod, file: string): Promise<void> => {
    recorded.push({ method, path: file });
    const index = armed.findIndex((entry) => entry.method === method && entry.match(file));
    if (index === -1) return;
    const [entry] = armed.splice(index, 1);
    entry?.arrive();
    await entry?.parked;
  };
  const fileSystem: FileSystem = {
    ...base,
    readTextFile: async (file) => {
      await parkIfArmed('readTextFile', file);
      return base.readTextFile(file);
    },
    readOwnerOnlyTextFile: async (file, description, maxBytes) => {
      await parkIfArmed('readOwnerOnlyTextFile', file);
      return base.readOwnerOnlyTextFile(file, description, maxBytes);
    },
    mkdirPrivate: async (directory) => {
      await parkIfArmed('mkdirPrivate', directory);
      return base.mkdirPrivate(directory);
    },
    rename: async (from, to) => {
      await parkIfArmed('rename', to);
      return base.rename(from, to);
    },
  };
  return {
    fileSystem,
    recorded,
    gate: (method, match) => {
      let arrive = (): void => undefined;
      let release = (): void => undefined;
      let fail = (_error: Error): void => undefined;
      const reached = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      const parked = new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
      armed.push({ method, match, arrive, parked });
      return { reached, release, fail };
    },
  };
};

export type RecordingSerial = Serial & { runs: number; active: number; maxActive: number; started: number[]; finished: number[] };

export const recordingSerial = (): RecordingSerial => {
  const inner = createSerial();
  const serial: RecordingSerial = {
    runs: 0,
    active: 0,
    maxActive: 0,
    started: [],
    finished: [],
    run: (work) => {
      serial.runs += 1;
      const index = serial.runs;
      return inner.run(async () => {
        serial.active += 1;
        serial.maxActive = Math.max(serial.maxActive, serial.active);
        serial.started.push(index);
        try {
          return await work();
        } finally {
          serial.active -= 1;
          serial.finished.push(index);
        }
      });
    },
  };
  return serial;
};

export const resettingFetch = (): PlanFetch => async () => {
  throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
};

export const TOKEN_ATTEMPT_BOUND_MS = 15_000;
export const REVOCATION_ATTEMPT_BOUND_MS = 10_000;

type PendingBound = { ms: number; resolve(): void };

export type Harness = {
  home: string;
  paths: { sessions: string; host: string; active: string };
  clock: FakeClock;
  auth: SiwcAuth;
  profile: PlanProfile;
  store: ListableCredentialStore;
  sessions: PlanSessions;
  sleeps: number[];
  fileSystem: FileSystem;
  secrets: string[];
  fed: Map<string, string[]>;
  warnings: string[];
  fetchUrls: string[];
  events: RecordedPlanEvent[];
  holdNextRefresh(): Gate;
  holdNextRevoke(): Gate;
  holdNextBackoff(): ReachedGate;
  failNextOutbound(error: Error): void;
  pendingBounds(): number[];
  fireLatestBound(ms: number): void;
  rewriteRefresh(change: (body: Record<string, unknown>) => Record<string, unknown>): void;
  reopen(options?: { accounts?: Array<{ profile: string; account: string }>; store?: ListableCredentialStore; lock?: KernelLockMechanism }): Promise<PlanSessions>;
  close(): Promise<void>;
};

export const recordKey = (account: string): string => `plan/${PROFILE_ID}/${account}`;

export const profileFor = (auth: SiwcAuth): PlanProfile => {
  const shipped = planProfileOf(PROFILE_ID);
  return {
    ...shipped,
    oauth: { ...shipped.oauth, issuer: auth.issuer, discoveryUrl: auth.discoveryUrl, authorizeUrl: auth.authorizeUrl, tokenUrl: auth.tokenUrl, jwksUrl: auth.jwksUrl },
  };
};

const isRefreshPost = (url: string, init: RequestInit, tokenUrl: string): boolean =>
  url === tokenUrl && typeof init.body !== 'undefined' && new URLSearchParams(String(init.body)).get('grant_type') === 'refresh_token';

export const startHarness = async (options: { profile?: (auth: SiwcAuth) => PlanProfile; wrapFileSystem?: (base: FileSystem) => FileSystem; pointerSerial?: Serial } = {}): Promise<Harness> => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'momonga-plan-'));
  const layout = momongaLayout(home);
  const paths = { sessions: layout.planSessions, host: layout.planHost, active: layout.planActive };
  const clock = createFakeClock(START_MS);
  const auth = await startFakeSiwcAuth({ now: clock.now });
  const profile = (options.profile ?? profileFor)(auth);
  const store = createEncryptedCredentialStore({
    directory: paths.sessions,
    stateDirectory: layout.state,
    secretStore: { kind: 'none', reason: 'the harness keeps plaintext records' },
    plaintextTokenFiles: () => true,
    keyOfPlaintext: planRecordKeyOfPlaintext,
  });
  const sleeps: number[] = [];
  const secrets: string[] = [];
  const fed = new Map<string, string[]>();
  const fileSystem = (options.wrapFileSystem ?? ((base: FileSystem) => base))(nodeFileSystem);
  const backoffGates: ReachedGate[] = [];
  const backoffArrivals: Array<() => void> = [];
  const outboundFailures: Error[] = [];
  const warnings: string[] = [];
  const fetchUrls: string[] = [];
  const events: RecordedPlanEvent[] = [];
  const gates: Gate[] = [];
  const revokeGates: Gate[] = [];
  const bounds: PendingBound[] = [];
  const heldUntilAbort = (gate: Gate, signal: AbortSignal | null | undefined): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      void gate.held.then(resolve);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  const rewrites: Array<(body: Record<string, unknown>) => Record<string, unknown>> = [];
  const fetchPort: TokenFetch = async (url, init) => {
    fetchUrls.push(url);
    if (isRefreshPost(url, init, auth.tokenUrl)) {
      const gate = gates.shift();
      if (gate !== undefined) await heldUntilAbort(gate, init.signal);
      const rewrite = rewrites.shift();
      if (rewrite !== undefined) {
        const response = await fetch(url, init);
        const body = (await response.json()) as Record<string, unknown>;
        return new Response(JSON.stringify(rewrite(body)), { status: response.status, headers: { 'content-type': 'application/json' } });
      }
    }
    if (url === auth.revokeUrl) {
      const gate = revokeGates.shift();
      if (gate !== undefined) await heldUntilAbort(gate, init.signal);
    }
    return fetch(url, init);
  };
  const newGate = (): Gate => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { held, release };
  };
  const open = (accounts: Array<{ profile: string; account: string }> = [], chosenStore: ListableCredentialStore = store, lock?: KernelLockMechanism): Promise<PlanSessions> =>
    openPlanSessions({
      ...(lock === undefined ? {} : { lock }),
      ...(options.pointerSerial === undefined ? {} : { pointerSerial: options.pointerSerial }),
      profiles: { [PROFILE_ID]: profile },
      paths,
      store: chosenStore,
      fileSystem,
      accounts,
      clock,
      outbound: (signal, use) => {
        const failure = outboundFailures.shift();
        if (failure !== undefined) return Promise.reject(failure);
        signal.throwIfAborted();
        return use(fetchPort);
      },
      sleep: (ms, signal) => {
        if (ms !== TOKEN_ATTEMPT_BOUND_MS && ms !== REVOCATION_ATTEMPT_BOUND_MS) {
          sleeps.push(ms);
          const backoff = backoffGates.shift();
          if (backoff === undefined) return Promise.resolve();
          backoffArrivals.shift()?.();
          return new Promise<void>((resolve, reject) => {
            void backoff.held.then(resolve);
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        return new Promise<void>((resolve, reject) => {
          const entry: PendingBound = { ms, resolve };
          bounds.push(entry);
          signal?.addEventListener(
            'abort',
            () => {
              bounds.splice(bounds.indexOf(entry), 1);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
      redact: (key, values) => {
        fed.set(key, [...values]);
        secrets.push(...values);
      },
      warn: (message) => {
        warnings.push(message);
      },
      events: (name, data) => {
        events.push({ name, data: data as Record<string, unknown> });
      },
    });
  const harness: Harness = {
    home,
    paths,
    clock,
    auth,
    profile,
    store,
    sessions: await open(),
    fileSystem,
    sleeps,
    secrets,
    fed,
    warnings,
    fetchUrls,
    events,
    holdNextRefresh: () => {
      const gate = newGate();
      gates.push(gate);
      return gate;
    },
    holdNextRevoke: () => {
      const gate = newGate();
      revokeGates.push(gate);
      return gate;
    },
    holdNextBackoff: () => {
      const gate = newGate();
      let arrive = (): void => undefined;
      const reached = new Promise<void>((resolve) => {
        arrive = resolve;
      });
      const held = { ...gate, reached };
      backoffGates.push(held);
      backoffArrivals.push(arrive);
      return held;
    },
    failNextOutbound: (error) => {
      outboundFailures.push(error);
    },
    pendingBounds: () => bounds.map((bound) => bound.ms),
    fireLatestBound: (ms) => {
      const index = bounds.map((bound) => bound.ms).lastIndexOf(ms);
      if (index === -1) throw new Error(`no pending ${ms} ms bound`);
      const [bound] = bounds.splice(index, 1);
      bound?.resolve();
    },
    rewriteRefresh: (change) => {
      rewrites.push(change);
    },
    reopen: async (reopenOptions = {}) => {
      await harness.sessions.close();
      harness.sessions = await open(reopenOptions.accounts ?? [], reopenOptions.store ?? store, reopenOptions.lock);
      return harness.sessions;
    },
    close: async () => {
      await harness.sessions.close();
      await auth.close();
      await fs.rm(home, { recursive: true, force: true });
    },
  };
  return harness;
};

const pkce = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

export type FakeSignIn = { clientId: string; hostId: string; idToken: string; subject: string; email: string; tokens: PlanTokenResponse };

export const signInAtFake = async (h: Harness, options: { clientId?: string; resource?: string } = {}): Promise<FakeSignIn> => {
  const host = await ensureHostIdentity(nodeFileSystem, h.paths.host, { accountsExist: false });
  const { verifier, challenge } = pkce();
  const redirectUri = 'http://127.0.0.1:49152/auth/callback';
  const resource = options.resource ?? SIWC_RESOURCE;
  const url = new URL(h.auth.authorizeUrl);
  const query: Record<string, string> = {
    client_id: options.clientId ?? 'dynamic_agent_client',
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    resource,
    state: randomBytes(16).toString('hex'),
    nonce: randomBytes(16).toString('hex'),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    ext_agent_host_id: host.hostId,
  };
  if (options.clientId === undefined) query['agent_name_hint'] = 'MomongaCode';
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const browsed = await siwcBrowse(url.toString());
  const callback = browsed.redirect;
  if (callback === undefined) throw new Error(`the fake refused the authorization: ${JSON.stringify(browsed.body)}`);
  const clientId = callback.searchParams.get('client_id') ?? options.clientId ?? '';
  const response = await fetch(h.auth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: callback.searchParams.get('code') ?? '',
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource,
    }).toString(),
  });
  const tokens = (await response.json()) as PlanTokenResponse & { id_token: string };
  return { clientId, hostId: host.hostId, idToken: tokens.id_token, subject: h.auth.identity.sub, email: h.auth.identity.email, tokens };
};

export const signedIn = async (h: Harness, account: string): Promise<FakeSignIn> => {
  const signIn = await signInAtFake(h);
  const registered = await h.sessions.register({ profile: PROFILE_ID, account, clientId: signIn.clientId, hostId: signIn.hostId });
  if (registered.outcome !== 'registered') throw new Error(`register failed: ${JSON.stringify(registered)}`);
  const installed = await h.sessions.install({
    profile: PROFILE_ID,
    account,
    clientId: signIn.clientId,
    hostId: signIn.hostId,
    subject: signIn.subject,
    email: signIn.email,
    idToken: signIn.idToken,
    tokens: signIn.tokens,
  });
  if (installed.outcome !== 'signed_in') throw new Error(`install failed: ${JSON.stringify(installed)}`);
  return signIn;
};

export const readRecord = async (h: Harness, account: string): Promise<Record<string, unknown> | undefined> => {
  const raw = await h.store.read(recordKey(account));
  return raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>);
};

export const writeSigningOut = async (h: Harness, account: string): Promise<void> => {
  const current = await readRecord(h, account);
  if (current === undefined) throw new Error(`no record for ${account}`);
  await h.store.write(recordKey(account), JSON.stringify({ ...current, state: 'signing_out' }));
};

export const rawRecord = (h: Harness, account: string): Promise<string | undefined> => h.store.read(recordKey(account));

export const editRecord = async (h: Harness, account: string, change: (record: Record<string, unknown>) => Record<string, unknown>): Promise<void> => {
  const current = await readRecord(h, account);
  if (current === undefined) throw new Error(`no record for ${account}`);
  await h.store.write(recordKey(account), JSON.stringify(change(current)));
};

export const recordFileOf = (h: Harness, account: string): string =>
  path.join(h.paths.sessions, `${createHash('sha256').update(recordKey(account)).digest('hex')}.json`);

export const toRefreshWindow = (h: Harness, installedAt: number): void => {
  h.clock.set(installedAt + ACCESS_LIFETIME_MS - MARGIN_MS);
};

export const rotateAtFake = async (h: Harness, clientId: string, refreshToken: string): Promise<void> => {
  const response = await fetch(h.auth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource: 'https://api.openai.com/v1' }).toString(),
  });
  if (response.status !== 200) throw new Error(`the fake refused the rotation: ${response.status}`);
};

export const failingWrites = (inner: ListableCredentialStore, fails: (value: string) => Error | undefined): ListableCredentialStore => ({
  read: (key) => inner.read(key),
  remove: (key) => inner.remove(key),
  write: (key, value) => {
    const error = fails(value);
    return error === undefined ? inner.write(key, value) : Promise.reject(error);
  },
  withKey: (key, action) =>
    inner.withKey(key, (entry) =>
      action({
        read: () => entry.read(),
        remove: () => entry.remove(),
        write: (value) => {
          const error = fails(value);
          return error === undefined ? entry.write(value) : Promise.reject(error);
        },
      }),
    ),
  update: (key, change) =>
    inner.update(key, (current) => {
      const next = change(current);
      const error = fails(next);
      if (error !== undefined) throw error;
      return next;
    }),
  listKeys: () => inner.listKeys(),
});

export const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: simulated`), { code });

export const storeKeyFailure = (): CredentialStoreError =>
  new CredentialStoreError('store_unwritable', 'the credential key could not be read or created: simulated', { cause: new Error('simulated') });

export const planError = async (promise: Promise<unknown>): Promise<{ code: string; retryable: boolean; message: string }> => {
  try {
    await promise;
  } catch (error) {
    const typed = error as { code?: unknown; retryable?: unknown; message?: unknown };
    return { code: String(typed.code), retryable: typed.retryable === true, message: String(typed.message) };
  }
  throw new Error('expected the plan credential call to fail');
};
