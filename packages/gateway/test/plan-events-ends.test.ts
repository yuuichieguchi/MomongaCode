import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeFileSystem } from '@momonga/foundation';
import { PLAN_ROUTES, PLAN_STORE_UNWRITABLE_CODE } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, siwcBrowse } from '@momonga/testkit';
import { PlanCredentialError } from '../src/plan/auth-source.ts';
import { createPlanCatalog } from '../src/plan/catalog.ts';
import { createPlanSignIn } from '../src/plan/signin.ts';
import type { PlanSessions } from '../src/plan/session.ts';
import { fakeAuth } from './plan-auth-support.ts';
import { ACCOUNT, signIn, startPlanGateway } from './plan-signin-support.ts';
import {
  CONDITION_WAIT,
  PAUSE_CODE,
  PROFILE_ID,
  START_MS,
  createGatedFileSystem,
  errno,
  failingWrites,
  readRecord,
  signedIn,
  startHarness,
  storeKeyFailure,
  toRefreshWindow,
  writeSigningOut,
} from './plan-support.ts';
import type { GatedFileSystem, Harness, RecordedPlanEvent } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const work = { profile: PROFILE_ID, account: 'work' };

const signal = (): AbortSignal => new AbortController().signal;

const PORT = 49152;

const named = (h: Harness, name: string): Array<Record<string, unknown>> => h.events.filter((event: RecordedPlanEvent) => event.name === name).map((event) => event.data);

const valueOf = (key: string, state?: string) => (value: string): boolean => {
  const record = JSON.parse(value) as Record<string, unknown>;
  return record[key] !== undefined && (state === undefined || record['state'] === state);
};

const stateIs = (state: string) => (value: string): boolean => (JSON.parse(value) as Record<string, unknown>)['state'] === state;

const boundSleep = (_ms: number, sleepSignal?: AbortSignal): Promise<void> =>
  new Promise<void>((_resolve, reject) => {
    sleepSignal?.addEventListener('abort', () => reject(sleepSignal.reason), { once: true });
  });

const signInOver = (h: Harness, sessions: PlanSessions, fileSystem = nodeFileSystem) =>
  createPlanSignIn({
    profiles: { [PROFILE_ID]: h.profile },
    sessions,
    clock: h.clock,
    outbound: (outboundSignal, use) => {
      outboundSignal.throwIfAborted();
      return use((url, init) => fetch(url, init));
    },
    lifetime: h.sessions.lifetime,
    sleep: boundSleep,
    fileSystem,
    hostFile: h.paths.host,
    events: (name, data) => {
      h.events.push({ name, data: data as Record<string, unknown> });
    },
  });

const completeSignIn = async (signIn: ReturnType<typeof signInOver>) => {
  const { attemptId, authorizationUrl } = await signIn.begin({ profile: PROFILE_ID, account: 'work', port: PORT }, new AbortController().signal);
  const browsed = await siwcBrowse(authorizationUrl);
  if (browsed.redirect === undefined) throw new Error(`the fake refused the authorization: ${JSON.stringify(browsed.body)}`);
  return signIn.complete(attemptId, browsed.redirect.href, signal());
};

describe('every started plan operation writes its event at every end (P-G6)', () => {
  it('a sign-in whose install write fails writes plan.sign_in failed with failure plan_store_unwritable and endStep 10', async () => {
    let gated: GatedFileSystem | undefined;
    const h = await startHarness({
      wrapFileSystem: (base) => {
        gated = createGatedFileSystem(base);
        return gated.fileSystem;
      },
    });
    harnesses.push(h);
    if (gated === undefined) throw new Error('the harness did not wrap its file system');
    const pointer = gated.gate('rename', (to) => to === h.paths.active);
    const completed = completeSignIn(signInOver(h, h.sessions)).catch((error: unknown) => error);
    await pointer.reached;
    pointer.fail(new Error('EACCES: simulated'));
    await completed;
    expect(named(h, 'plan.sign_in')).toEqual([expect.objectContaining({ outcome: 'failed', failure: 'plan_store_unwritable', endStep: 10 })]);
  });

  it.each([
    { form: 'the errno rejection of the real store', fails: () => errno('EACCES'), cause: 'EACCES: simulated' },
    { form: 'a CredentialStoreError store_unwritable rejection', fails: () => storeKeyFailure(), cause: 'the credential key could not be read or created: simulated' },
  ])('a sign-in whose register write fails with $form writes failed with failure plan_store_unwritable and endStep 4', async ({ fails, cause }) => {
    const h = await startHarness();
    harnesses.push(h);
    await h.reopen({ store: failingWrites(h.store, (value) => (valueOf('client_id', 'registered')(value) ? fails() : undefined)) });
    const rejection = await completeSignIn(signInOver(h, h.sessions)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(PlanCredentialError);
    expect(rejection).toMatchObject({ code: PLAN_STORE_UNWRITABLE_CODE, message: `the plan session of chatgpt account work could not be written: ${cause}` });
    expect(named(h, 'plan.sign_in')).toEqual([expect.objectContaining({ outcome: 'failed', failure: 'plan_store_unwritable', endStep: 4 })]);
  });

  it('a plain Error from install writes failed with internal and endStep 10', async () => {
    const h = await startHarness();
    harnesses.push(h);
    const sessions: PlanSessions = {
      ...h.sessions,
      install: async () => {
        throw new Error('the sign-in installed nothing: the token response has no granted scope');
      },
    };
    await completeSignIn(signInOver(h, sessions)).catch(() => undefined);
    expect(named(h, 'plan.sign_in')).toEqual([expect.objectContaining({ outcome: 'failed', failure: 'internal', endStep: 10 })]);
  });

  it('host identity unavailable at begin writes no sign_in event', async () => {
    const h = await startHarness();
    harnesses.push(h);
    const gated = createGatedFileSystem(nodeFileSystem);
    const read = gated.gate('readOwnerOnlyTextFile', (file) => file === h.paths.host);
    const begun = signInOver(h, h.sessions, gated.fileSystem).begin({ profile: PROFILE_ID, account: 'work', port: PORT }, new AbortController().signal).catch((error: unknown) => error);
    await read.reached;
    read.fail(new Error('read failed'));
    expect(await begun).toMatchObject({ code: 'plan_host_identity_unavailable' });
    expect(named(h, 'plan.sign_in')).toEqual([]);
  });

  it('a refresh whose intent write fails writes plan.refresh failed, code plan_store_unwritable, attempts 0', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    await h.reopen({ accounts: [work], store: failingWrites(h.store, (value) => (valueOf('pendingRefresh')(value) ? errno('EACCES') : undefined)) });
    toRefreshWindow(h, START_MS);
    await h.sessions.authSource(work).read(signal()).catch(() => undefined);
    expect(named(h, 'plan.refresh')).toEqual([expect.objectContaining({ outcome: 'failed', code: 'plan_store_unwritable', attempts: 0 })]);
    expect(h.auth.calls.tokenRefreshToken).toBe(0);
  });

  it('a refresh stopped by the lifetime signal writes outcome transient with attempts as made', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    h.auth.scriptToken('refresh_token', [{ kind: 'http', status: 503 }]);
    const gate = h.holdNextBackoff();
    toRefreshWindow(h, START_MS);
    const reading = h.sessions.authSource(work).read(signal()).catch(() => undefined);
    await gate.reached;
    let closed = false;
    const closing = h.sessions.close().then(() => {
      closed = true;
    });
    try {
      await vi.waitFor(() => expect(closed).toBe(true), CONDITION_WAIT);
    } finally {
      gate.release();
      await closing;
      await reading;
    }
    expect(named(h, 'plan.refresh')).toEqual([expect.objectContaining({ outcome: 'transient', attempts: 1 })]);
  });

  it('rejected: the caller\'s signal aborting the wait writes answer aborted', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    h.clock.advance(60_000);
    const source = h.sessions.authSource(work);
    const { generation } = await source.read(signal());
    const gate = h.holdNextRefresh();
    const controller = new AbortController();
    const waiting = source.rejected(generation, controller.signal).catch(() => undefined);
    await vi.waitFor(() => expect(h.fetchUrls.filter((url) => url === h.auth.tokenUrl)).toHaveLength(1), CONDITION_WAIT);
    controller.abort(new Error('the caller went away'));
    await waiting;
    gate.release();
    expect(named(h, 'plan.rejected')).toEqual([expect.objectContaining({ answer: 'aborted', generation })]);
  });

  it('a sign-out whose signing_out write fails writes end failed, revocation none, code plan_store_unwritable', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    await h.reopen({ accounts: [work], store: failingWrites(h.store, (value) => (stateIs('signing_out')(value) ? errno('EACCES') : undefined)) });
    const rejection = await h.sessions.signOut(work, signal()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(PlanCredentialError);
    expect(rejection).toMatchObject({ code: PLAN_STORE_UNWRITABLE_CODE });
    expect(named(h, 'plan.sign_out')).toEqual([{ profile: PROFILE_ID, account: 'work', resumed: false, end: 'failed', revocation: 'none', code: 'plan_store_unwritable' }]);
  });

  it('a sign-out whose cleared-record write fails after a confirmed revocation writes end failed, revocation confirmed, code plan_store_unwritable', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    await h.reopen({ accounts: [work], store: failingWrites(h.store, (value) => (stateIs('registered')(value) ? errno('EACCES') : undefined)) });
    await h.sessions.signOut(work, signal()).catch(() => undefined);
    expect(h.auth.calls.revoke).toBe(1);
    expect(named(h, 'plan.sign_out')).toEqual([{ profile: PROFILE_ID, account: 'work', resumed: false, end: 'failed', revocation: 'confirmed', code: 'plan_store_unwritable' }]);
  });

  it('a resumed sign-out whose D5 acquire fails writes end interrupted', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    await writeSigningOut(h, 'work');
    h.failNextOutbound(new Error('d5 down'));
    await h.reopen({ accounts: [work] });
    await vi.waitFor(() => expect(h.events.find((event) => event.name === 'plan.sign_out')?.data).toMatchObject({ end: 'interrupted', revocation: 'none', resumed: true }), CONDITION_WAIT);
  });

  it('a plan.pause event carries saved true, and false when the write fails', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    await h.sessions.authSource(work).pause({ code: PAUSE_CODE }, new AbortController().signal);
    await h.sessions.resume(work, new AbortController().signal);
    await h.reopen({ accounts: [work], store: failingWrites(h.store, (value) => (valueOf('paused')(value) ? errno('EACCES') : undefined)) });
    await h.sessions.authSource(work).pause({ code: PAUSE_CODE }, new AbortController().signal).catch(() => undefined);
    expect(named(h, 'plan.pause').map((event) => event['saved'])).toEqual([true, false]);
    expect((await readRecord(h, 'work'))?.['paused']).toBeUndefined();
  });

  it('an AuthSource whose pause rejects after a classified usage-limit answer ends the catalog read with the usage-limit failure, the pause failure as its cause, with requestIdHeaders', async () => {
    const h = await startHarness();
    harnesses.push(h);
    const events: RecordedPlanEvent[] = [];
    const error = new Error('pause port failed');
    const catalog = createPlanCatalog({
      store: h.store,
      clock: h.clock,
      outbound: (_signal, use) =>
        use(async () => new Response(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit', param: null } }), { status: 429, headers: { 'x-request-id': 'req_1' } })),
      sleep: boundSleep,
      events: (name, data) => {
        events.push({ name, data: data as Record<string, unknown> });
      },
    });
    const auth = {
      ...fakeAuth(),
      pause: async () => {
        throw error;
      },
    };
    await expect(catalog.read({ profile: h.profile, account: 'work', refresh: true, auth, signal: signal() })).rejects.toMatchObject({ body: { code: PAUSE_CODE }, cause: error });
    expect(events.filter((event) => event.name === 'plan.catalog').map((event) => event.data)).toEqual([{ profile: 'chatgpt', account: 'work', outcome: PAUSE_CODE, requestIdHeaders: ['x-request-id'] }]);
  });

  it('a catalog record write that fails after the list was read rejects plan_store_unwritable and keeps the ok event', async () => {
    const h = await startHarness();
    harnesses.push(h);
    const events: RecordedPlanEvent[] = [];
    const { listKey, idKey, labelKey, filter } = h.profile.catalog;
    const listed = { [listKey]: [{ [idKey]: 'plan-model', [labelKey]: 'Plan Model', [filter.field]: filter.equals, context_window: 200000 }] };
    const catalog = createPlanCatalog({
      store: failingWrites(h.store, () => errno('EACCES')),
      clock: h.clock,
      outbound: (_signal, use) => use(async () => new Response(JSON.stringify(listed), { status: 200 })),
      sleep: boundSleep,
      events: (name, data) => {
        events.push({ name, data: data as Record<string, unknown> });
      },
    });
    const rejection = await catalog.read({ profile: h.profile, account: 'work', refresh: true, auth: fakeAuth(), signal: signal() }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(PlanCredentialError);
    expect(rejection).toMatchObject({ code: PLAN_STORE_UNWRITABLE_CODE, message: 'the plan model list of chatgpt account work could not be written: EACCES: simulated' });
    expect(events.filter((event) => event.name === 'plan.catalog').map((event) => event.data['outcome'])).toEqual(['ok']);
  });

  it('a sign-out through the route whose signing_out write fails answers 500 server_error plan_store_unwritable', async () => {
    const gateway = await startPlanGateway({ planStore: (store) => failingWrites(store, (value) => (stateIs('signing_out')(value) ? errno('EACCES') : undefined)) });
    expect((await signIn(gateway)).completed.status).toBe(200);
    const answer = await gateway.post(PLAN_ROUTES.signOut, { profile: PROFILE_ID, account: ACCOUNT });
    expect(answer.status).toBe(500);
    expect(answer.body.error).toMatchObject({
      type: 'server_error',
      code: 'plan_store_unwritable',
      message: 'the plan session of chatgpt account work could not be written: EACCES: simulated',
    });
    await gateway.close();
  });
});
