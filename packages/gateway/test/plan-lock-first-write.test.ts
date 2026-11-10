import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { ListableCredentialStore } from '@momonga/foundation';
import { ACCESS_LIFETIME_MS, PROFILE_ID, SKEW_MS, START_MS, errno, failingWrites, planError, rawRecord, refusingLocks, signInAtFake, signedIn, startHarness, toRefreshWindow } from './plan-support.ts';
import type { FakeSignIn, Harness, RecordedPlanEvent } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const harness = async (): Promise<Harness> => {
  const h = await startHarness();
  harnesses.push(h);
  return h;
};

const work = { profile: PROFILE_ID, account: 'work' };

const signal = (): AbortSignal => new AbortController().signal;

const UNWRITABLE = 'the plan session of chatgpt account work could not be written: EROFS: simulated';

const named = (h: Harness, name: string): Array<RecordedPlanEvent['data']> => h.events.filter((event) => event.name === name).map((event) => event.data);

const hasIntent = (value: string): boolean => (JSON.parse(value) as Record<string, unknown>)['pendingRefresh'] !== undefined;

type Injection = (store: ListableCredentialStore) => ListableCredentialStore;

const failedIntentWrite: Injection = (store) => failingWrites(store, (value) => (hasIntent(value) ? errno('EROFS') : undefined));

const refusedLock: Injection = (store) => refusingLocks(store, () => errno('EROFS'));

type Observation = { answer: unknown; refreshEvents: unknown[]; rejectedEvents: unknown[]; refreshSends: number; status: unknown };

type Scenario = (h: Harness, signIn: FakeSignIn) => Promise<unknown>;

const settled = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    (value) => ({ value }),
    (error: unknown) => ({ code: (error as { code?: unknown }).code, message: (error as { message?: unknown }).message }),
  );

const observed = async (inject: Injection, scenario: Scenario): Promise<{ observation: Observation; signIn: FakeSignIn }> => {
  const h = await harness();
  const signIn = await signedIn(h, 'work');
  await h.reopen({ accounts: [work], store: inject(h.store) });
  const answer = await scenario(h, signIn);
  const source = h.sessions.authSource(work);
  return {
    signIn,
    observation: { answer, refreshEvents: named(h, 'plan.refresh'), rejectedEvents: named(h, 'plan.rejected'), refreshSends: h.auth.calls.tokenRefreshToken, status: source.status() },
  };
};

const withoutBearer = (answer: unknown): unknown => {
  const value = (answer as { value?: { bearer?: unknown; generation?: unknown } }).value;
  return value === undefined || typeof value !== 'object' ? answer : { value: { generation: value.generation } };
};

const comparable = (observation: Observation): Observation => ({ ...observation, answer: withoutBearer(observation.answer) });

const lazyReadWithAValidToken: Scenario = (h) => {
  toRefreshWindow(h, START_MS);
  return settled(h.sessions.authSource(work).read(signal()));
};

const lazyReadWithAnExpiredToken: Scenario = (h) => {
  h.clock.set(START_MS + ACCESS_LIFETIME_MS - SKEW_MS);
  return settled(h.sessions.authSource(work).read(signal()));
};

const forcedRefresh: Scenario = async (h) => {
  h.clock.advance(SKEW_MS);
  const source = h.sessions.authSource(work);
  const { generation } = await source.read(signal());
  return settled(source.rejected(generation, signal()));
};

describe('a refresh whose record lock cannot be taken ends as a refresh whose intent write failed (K1, W3)', () => {
  it('a lazy read with a still valid token is served the held token, marks the write failure, sends nothing and writes plan.refresh failed with attempts 0', async () => {
    const { observation, signIn } = await observed(refusedLock, lazyReadWithAValidToken);
    expect(observation.answer).toEqual({ value: { bearer: signIn.tokens.access_token, generation: 1 } });
    expect(observation.refreshEvents).toEqual([expect.objectContaining({ profile: PROFILE_ID, account: 'work', outcome: 'failed', code: 'plan_store_unwritable', attempts: 0 })]);
    expect(observation.refreshSends).toBe(0);
    expect(observation.status).toEqual({ state: 'store_unwritable', cause: 'EROFS: simulated' });
  });

  it.for([
    { name: 'a lazy read with a still valid token', scenario: lazyReadWithAValidToken },
    { name: 'a lazy read with a token inside the skew', scenario: lazyReadWithAnExpiredToken },
    { name: 'a forced refresh after a rejected token', scenario: forcedRefresh },
  ])('$name: the answer, the events, the sends and the status equal those of a failed intent write', async ({ scenario }) => {
    const reference = await observed(failedIntentWrite, scenario);
    const refused = await observed(refusedLock, scenario);
    expect(reference.observation.refreshEvents).toEqual([expect.objectContaining({ outcome: 'failed', code: 'plan_store_unwritable', attempts: 0 })]);
    expect(reference.observation.refreshSends).toBe(0);
    expect(comparable(refused.observation)).toEqual(comparable(reference.observation));
  });
});

describe('a sign-out, a register and an install whose record lock cannot be taken fail as their first write does (K1)', () => {
  it('a sign-out answers plan_store_unwritable, writes end failed with revocation none, sends nothing and leaves the account active', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await h.reopen({ accounts: [work], store: refusedLock(h.store) });
    expect(await planError(h.sessions.signOut(work, signal()))).toEqual({ code: 'plan_store_unwritable', retryable: false, message: UNWRITABLE });
    expect(named(h, 'plan.sign_out')).toEqual([{ profile: PROFILE_ID, account: 'work', resumed: false, end: 'failed', revocation: 'none', code: 'plan_store_unwritable' }]);
    expect(h.auth.calls.revoke).toBe(0);
    expect(h.sessions.authSource(work).status().state).toBe('active');
  });

  it('a register answers plan_store_unwritable and writes no record', async () => {
    const h = await harness();
    const signIn = await signInAtFake(h);
    await h.reopen({ store: refusedLock(h.store) });
    expect(await planError(h.sessions.register({ profile: PROFILE_ID, account: 'work', clientId: signIn.clientId, hostId: signIn.hostId }))).toEqual({
      code: 'plan_store_unwritable',
      retryable: false,
      message: UNWRITABLE,
    });
    expect(await rawRecord(h, 'work')).toBeUndefined();
  });

  it('an install answers plan_store_unwritable, leaves the record bytes and does not move the active pointer', async () => {
    const h = await harness();
    const signIn = await signInAtFake(h);
    await h.sessions.register({ profile: PROFILE_ID, account: 'work', clientId: signIn.clientId, hostId: signIn.hostId });
    const before = await rawRecord(h, 'work');
    await h.reopen({ store: refusedLock(h.store) });
    const installing = h.sessions.install({
      profile: PROFILE_ID,
      account: 'work',
      clientId: signIn.clientId,
      hostId: signIn.hostId,
      subject: signIn.subject,
      email: signIn.email,
      idToken: signIn.idToken,
      tokens: signIn.tokens,
    });
    expect(await planError(installing)).toEqual({ code: 'plan_store_unwritable', retryable: false, message: UNWRITABLE });
    expect(await rawRecord(h, 'work')).toBe(before);
    expect(h.sessions.activeLabel(PROFILE_ID)).toBeUndefined();
    await expect(fs.access(h.paths.active)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
