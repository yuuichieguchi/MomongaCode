import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanProfile } from '@momonga/config';
import { FIRST_GENERATION, createEncryptedCredentialStore, momongaLayout, nodeFileSystem } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, createFakeSecretStore, planErrorHttpReply, startFakePlanResponses, startFakeSiwcAuth, testKernelLock } from '@momonga/testkit';
import { createPlanCatalog } from '../src/plan/catalog.ts';
import { openPlanSessions } from '../src/plan/session.ts';
import { postJson, readJson, registerCleanup, userInput } from './gateway-helpers.ts';
import { PROCESS_VERSION, baseEnv, clientFor, launchGateway, makeHome, writeSettings, modelsOf } from './gateway-process-helpers.ts';
import type { ListableCredentialStore } from '@momonga/foundation';
import { CONDITION_WAIT, PAUSE_CODE, PROFILE_ID, errno, failingWrites, planError, profileFor, readRecord, refusingLocks, signInAtFake, signedIn, startHarness } from './plan-support.ts';
import type { Harness, RecordedPlanEvent } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const harness = async (): Promise<Harness> => {
  const h = await startHarness();
  harnesses.push(h);
  return h;
};

const signal = (): AbortSignal => new AbortController().signal;

const work = { profile: PROFILE_ID, account: 'work' };

const hasPause = (value: string): boolean => (JSON.parse(value) as Record<string, unknown>)['paused'] !== undefined;

const failPausedWrites = async (h: Harness, code: string, times: number): Promise<void> => {
  let remaining = times;
  const store = failingWrites(h.store, (value) => {
    if (remaining === 0 || !hasPause(value)) return undefined;
    remaining -= 1;
    return errno(code);
  });
  await h.reopen({ accounts: [work], store });
};

const pauseEvents = (h: Harness): RecordedPlanEvent[] => h.events.filter((event) => event.name === 'plan.pause');

describe('a usage-limit pause adopts in memory first and persists by the dirty/retry rule (P-G9)', () => {
  it('a pause whose write fails resolves, pauses in memory (read fails plan_usage_paused), and writes plan.pause with saved false', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await failPausedWrites(h, 'EACCES', Number.POSITIVE_INFINITY);
    const source = h.sessions.authSource(work);
    await expect(source.pause({ code: PAUSE_CODE }, new AbortController().signal)).resolves.toBeUndefined();
    expect((await planError(source.read(signal()))).code).toBe('plan_usage_paused');
    expect(pauseEvents(h).map((event) => event.data)).toEqual([{ profile: PROFILE_ID, account: 'work', code: PAUSE_CODE, saved: false }]);
  });

  it('a transient write failure of the pause is retried and the file holds paused afterwards', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await failPausedWrites(h, 'ENOSPC', 1);
    await h.sessions.authSource(work).pause({ code: PAUSE_CODE }, new AbortController().signal);
    await vi.waitFor(async () => expect((await readRecord(h, 'work'))?.['paused']).toBeDefined(), CONDITION_WAIT);
    expect(h.sleeps).toContain(30_000);
  });

  it('a non-transient write failure of the pause leaves the account store_unwritable and paused in memory', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await failPausedWrites(h, 'EACCES', Number.POSITIVE_INFINITY);
    const source = h.sessions.authSource(work);
    await source.pause({ code: PAUSE_CODE }, new AbortController().signal);
    expect(source.status()).toMatchObject({ state: 'store_unwritable', paused: {} });
    expect((await planError(source.read(signal()))).code).toBe('plan_usage_paused');
    expect((await readRecord(h, 'work'))?.['paused']).toBeUndefined();
  });

  it('resume whose write fails resumes in memory and returns true', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    await h.sessions.authSource(work).pause({ code: PAUSE_CODE }, new AbortController().signal);
    const store = failingWrites(h.store, (value) => (hasPause(value) ? undefined : errno('EACCES')));
    await h.reopen({ accounts: [work], store });
    expect(await h.sessions.resume(work, new AbortController().signal)).toBe(true);
    expect((await h.sessions.authSource(work).read(signal())).bearer).toBe(signIn.tokens.access_token);
  });

  it('pause on an account with no record is a no-op without an event', async () => {
    const h = await harness();
    await expect(h.sessions.authSource({ profile: PROFILE_ID, account: 'nobody' }).pause({ code: PAUSE_CODE }, new AbortController().signal)).resolves.toBeUndefined();
    expect(pauseEvents(h)).toEqual([]);
  });

  it('a catalog read answered with a usage limit and an unwritable record raises the classified code and writes plan.catalog with that outcome', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await failPausedWrites(h, 'EACCES', Number.POSITIVE_INFINITY);
    const events: RecordedPlanEvent[] = [];
    const catalog = createPlanCatalog({
      store: h.store,
      clock: h.clock,
      outbound: (_signal, use) =>
        use(async () => new Response(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit', param: null } }), { status: 429 })),
      sleep: (_ms, abort) =>
        new Promise<void>((_resolve, reject) => {
          abort?.addEventListener('abort', () => reject(abort.reason), { once: true });
        }),
      events: (name, data) => {
        events.push({ name, data: data as Record<string, unknown> });
      },
    });
    const failure = await catalog.read({ profile: h.profile, account: 'work', refresh: true, auth: h.sessions.authSource(work), signal: signal() }).then(
      () => undefined,
      (error: unknown) => error as { body?: { code?: unknown } },
    );
    expect(failure?.body?.code).toBe(PAUSE_CODE);
    expect(events.filter((event) => event.name === 'plan.catalog').map((event) => event.data['outcome'])).toEqual([PAUSE_CODE]);
  });
});

type UsageLimitedGateway = { ask(): Promise<Awaited<ReturnType<typeof readJson>>>; upstreamPosts(): number; close(): Promise<void> };

const usageLimitedGateway = async (planStore: (store: ListableCredentialStore) => ListableCredentialStore): Promise<UsageLimitedGateway> => {
  const home = makeHome();
  const layout = momongaLayout(home, process.platform, process.env);
  const secretStore = createFakeSecretStore({});
  const upstream = await startFakePlanResponses({ verifyBearer: () => 'valid', script: [planErrorHttpReply('subscription_sharing_usage_limit_exceeded', {})] });
  registerCleanup(() => upstream.close());
  const loopback = `${upstream.origin}/v1`;
  const auth = await startFakeSiwcAuth({ resource: loopback });
  registerCleanup(() => auth.close());
  const shipped = profileFor(auth);
  const profile: PlanProfile = { ...shipped, oauth: { ...shipped.oauth!, resource: loopback }, targetDefaults: { ...shipped.targetDefaults, baseUrl: loopback } };
  fs.mkdirSync(layout.planSessions, { recursive: true, mode: 0o700 });
  const store = createEncryptedCredentialStore({
    lock: testKernelLock(),
    directory: layout.planSessions,
    stateDirectory: path.dirname(layout.planSessions),
    secretStore: { kind: 'available', store: secretStore },
    plaintextTokenFiles: () => false,
  });
  const clock = createFakeClock(Date.now());
  const sessions = await openPlanSessions({ lock: testKernelLock(), signal: new AbortController().signal,
    profiles: { [PROFILE_ID]: profile },
    paths: { sessions: layout.planSessions, host: layout.planHost, active: layout.planActive },
    store,
    fileSystem: nodeFileSystem,
    accounts: [],
    clock,
    outbound: (outboundSignal, use) => {
      outboundSignal.throwIfAborted();
      return use((url, init) => fetch(url, init));
    },
    sleep: (_ms, sleepSignal) =>
      new Promise<void>((_resolve, reject) => {
        sleepSignal?.addEventListener('abort', () => reject(sleepSignal.reason), { once: true });
      }),
    redact: () => undefined,
    warn: () => undefined,
  });
  const signIn = await signInAtFake({ paths: { host: layout.planHost }, auth } as unknown as Harness, { resource: profile.oauth!.resource });
  await sessions.register({ profile: PROFILE_ID, account: 'work', clientId: signIn.clientId, hostId: signIn.hostId }, new AbortController().signal);
  await sessions.install({ profile: PROFILE_ID, account: 'work', clientId: signIn.clientId, hostId: signIn.hostId, subject: signIn.subject, email: signIn.email, idToken: signIn.idToken, tokens: signIn.tokens }, new AbortController().signal);
  await sessions.close();

  writeSettings(home, { models: modelsOf({ gpt: { adapter: 'open-responses', model: 'm', capabilities: { contextWindow: 128000, maxOutputTokens: 16000 }, plan: { profile: PROFILE_ID, account: 'work' } } }) });
  const handle = await launchGateway({
    generation: FIRST_GENERATION,
    home,
    env: baseEnv(home),
    version: PROCESS_VERSION,
    secretStore,
    planProfiles: { [PROFILE_ID]: profile },
    clock,
    planStore,
  });
  return {
    ask: async () => readJson(await postJson(clientFor(handle.socketPath), '/v1/responses', { model: 'gpt/m', input: userInput('hi') })),
    upstreamPosts: () => upstream.requests.filter((request) => request.method === 'POST').length,
    close: async () => {
      await handle.close();
    },
  };
};

describe('a usage limit on the request path with an unwritable record (P-G9, gateway level)', () => {
  it('a 429 usage-limit answer with an unwritable record is answered as plan_usage_limit 429, the next request is plan_usage_paused 429, and no request goes upstream for it', async () => {
    let refusedPauseWrites = 0;
    const gateway = await usageLimitedGateway((recordStore) =>
      failingWrites(recordStore, (value) => {
        if (!hasPause(value)) return undefined;
        refusedPauseWrites += 1;
        return errno('EACCES');
      }),
    );
    const first = await gateway.ask();
    expect({ status: first.status, code: first.body.error?.code }).toEqual({ status: 429, code: PAUSE_CODE });
    expect(gateway.upstreamPosts()).toBe(1);
    const second = await gateway.ask();
    expect({ status: second.status, code: second.body.error?.code }).toEqual({ status: 429, code: 'plan_usage_paused' });
    expect(gateway.upstreamPosts()).toBe(1);
    expect(refusedPauseWrites).toBeGreaterThanOrEqual(1);
    await gateway.close();
  });

  it('a 429 usage-limit answer while the record lock cannot be taken is answered as plan_usage_limit 429, the next request is plan_usage_paused 429, and no request goes upstream for it (K1)', async () => {
    let refusedLocks = 0;
    const gateway = await usageLimitedGateway((recordStore) =>
      refusingLocks(recordStore, () => {
        refusedLocks += 1;
        return errno('EROFS');
      }),
    );
    const first = await gateway.ask();
    expect({ status: first.status, code: first.body.error?.code }).toEqual({ status: 429, code: PAUSE_CODE });
    expect(gateway.upstreamPosts()).toBe(1);
    const second = await gateway.ask();
    expect({ status: second.status, code: second.body.error?.code }).toEqual({ status: 429, code: 'plan_usage_paused' });
    expect(gateway.upstreamPosts()).toBe(1);
    expect(refusedLocks).toBeGreaterThanOrEqual(1);
    await gateway.close();
  });
});

const lockRefused = async (h: Harness, armed: () => boolean = () => true): Promise<{ refused(): number }> => {
  let refused = 0;
  const store = refusingLocks(h.store, () => {
    if (!armed()) return undefined;
    refused += 1;
    return errno('EROFS');
  });
  await h.reopen({ accounts: [work], store });
  return { refused: () => refused };
};

describe('a record lock that cannot be taken is a failed write under the dirty rule for pause and resume (K1)', () => {
  it('a pause whose lock cannot be taken resolves, pauses in memory, marks the write failure and writes plan.pause with saved false', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const locks = await lockRefused(h);
    const source = h.sessions.authSource(work);
    await expect(source.pause({ code: PAUSE_CODE }, new AbortController().signal)).resolves.toBeUndefined();
    expect(locks.refused()).toBe(1);
    expect((await planError(source.read(signal()))).code).toBe('plan_usage_paused');
    expect(source.status()).toEqual({ state: 'store_unwritable', cause: 'EROFS: simulated', paused: {} });
    expect(pauseEvents(h).map((event) => event.data)).toEqual([{ profile: PROFILE_ID, account: 'work', code: PAUSE_CODE, saved: false }]);
    expect((await readRecord(h, 'work'))?.['paused']).toBeUndefined();
  });

  it('a resume of the served account whose lock cannot be taken resolves, resumes in memory and marks the write failure', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    await h.sessions.authSource(work).pause({ code: PAUSE_CODE }, new AbortController().signal);
    const locks = await lockRefused(h);
    const source = h.sessions.authSource(work);
    await expect(source.resume(new AbortController().signal)).resolves.toBeUndefined();
    expect(locks.refused()).toBe(1);
    expect(source.status()).toEqual({ state: 'store_unwritable', cause: 'EROFS: simulated' });
    expect((await source.read(signal())).bearer).toBe(signIn.tokens.access_token);
    expect((await readRecord(h, 'work'))?.['paused']).toEqual({});
  });

  it('sessions.resume(ref) whose lock cannot be taken returns true, resumes in memory and marks the write failure', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    await h.sessions.authSource(work).pause({ code: PAUSE_CODE }, new AbortController().signal);
    const locks = await lockRefused(h);
    expect(await h.sessions.resume(work, new AbortController().signal)).toBe(true);
    expect(locks.refused()).toBe(1);
    const source = h.sessions.authSource(work);
    expect(source.status()).toEqual({ state: 'store_unwritable', cause: 'EROFS: simulated' });
    expect((await source.read(signal())).bearer).toBe(signIn.tokens.access_token);
  });

  it('a retry of a dirty record whose lock cannot be taken marks the account store_unwritable and is not a background failure', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    let pauseWriteFailures = 1;
    let armed = false;
    let refused = 0;
    const store = refusingLocks(
      failingWrites(h.store, (value) => {
        if (pauseWriteFailures === 0 || !hasPause(value)) return undefined;
        pauseWriteFailures -= 1;
        return errno('ENOSPC');
      }),
      () => {
        if (!armed) return undefined;
        refused += 1;
        return errno('EROFS');
      },
    );
    await h.reopen({ accounts: [work], store });
    const retryWait = h.holdNextBackoff();
    const source = h.sessions.authSource(work);
    await source.pause({ code: PAUSE_CODE }, new AbortController().signal);
    await retryWait.reached;
    expect(source.status()).toEqual({ state: 'active', paused: {} });
    armed = true;
    retryWait.release();
    await vi.waitFor(() => expect(refused).toBe(1), CONDITION_WAIT);
    await expect(h.sessions.close()).resolves.toBeUndefined();
    expect(source.status()).toEqual({ state: 'store_unwritable', cause: 'EROFS: simulated', paused: {} });
    expect(h.warnings.filter((warning) => warning.startsWith('a background plan session task failed'))).toEqual([]);
  });

  it('a retry of a dirty record whose lock cannot be taken for a transient reason is retried after the doubled wait (30 000 ms, then 60 000 ms) and the account is not marked unwritable', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    let pauseWriteFailures = 1;
    let lockRefusals = 0;
    let refused = 0;
    const store = refusingLocks(
      failingWrites(h.store, (value) => {
        if (pauseWriteFailures === 0 || !hasPause(value)) return undefined;
        pauseWriteFailures -= 1;
        return errno('ENOSPC');
      }),
      () => {
        if (lockRefusals === 0) return undefined;
        lockRefusals -= 1;
        refused += 1;
        return errno('EAGAIN');
      },
    );
    await h.reopen({ accounts: [work], store });
    const firstWait = h.holdNextBackoff();
    const secondWait = h.holdNextBackoff();
    const source = h.sessions.authSource(work);
    await source.pause({ code: PAUSE_CODE }, new AbortController().signal);
    await firstWait.reached;
    lockRefusals = 1;
    firstWait.release();
    const backgroundFailures = (): string[] => h.warnings.filter((warning) => warning.startsWith('a background plan session task failed'));
    const retryWaits = (): number[] => h.sleeps.filter((ms) => ms === 30_000 || ms === 60_000);
    await vi.waitFor(() => expect(retryWaits().length === 2 || backgroundFailures().length > 0).toBe(true), CONDITION_WAIT);
    expect(backgroundFailures()).toEqual([]);
    expect(refused).toBe(1);
    expect(retryWaits()).toEqual([30_000, 60_000]);
    expect(source.status()).toEqual({ state: 'active', paused: {} });
    secondWait.release();
    await vi.waitFor(async () => expect((await readRecord(h, 'work'))?.['paused']).toEqual({}), CONDITION_WAIT);
    expect(source.status()).toEqual({ state: 'active', paused: {} });
  });
});
