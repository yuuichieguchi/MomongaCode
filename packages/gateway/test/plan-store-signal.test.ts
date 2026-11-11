import { afterEach, describe, expect, it } from 'vitest';
import { OperationLimitError, SECURITY_BINARY, createKeychainSecretStore, limitEndOf, operationLimit } from '@momonga/foundation';
import type { SecretStore } from '@momonga/foundation';
import { createFakeSecretFiles, createFakeSecurityPort } from '@momonga/testkit';
import type { FakeControl } from '@momonga/testkit';
import { PlanCredentialError } from '../src/plan/session.ts';
import { withinRequestLimit } from '../src/plan/request-limit.ts';
import { CONDITION_WAIT, NEVER_ENDED, PAUSE_CODE, PROFILE_ID, START_MS, errno, planError, readRecord, signedIn, startHarness, toRefreshWindow, watchedStore } from './plan-support.ts';
import type { Harness, WatchedStore } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const WORK = { profile: PROFILE_ID, account: 'work' };
const PERSIST_RETRY_MS = 30_000;
const PERSIST_LIMIT_MS = 300_000;
const REQUEST_LIMIT_MS = 300_000;
const KEYCHAIN_PATH = '/Users/x/Library/Keychains/login.keychain-db';
const NO_STORE_TEXT =
  'No secret store was found on this host (security reports no default keychain (SecKeychainCopyDefault: A default keychain could not be found.)). MomongaCode does not keep sign-in tokens in a plain file unless you ask: set credentials.plaintextTokenFiles to true in your user settings to keep them in a file only you can read.';

const harness = async (secretStore?: SecretStore): Promise<Harness> => {
  const h = await startHarness(secretStore === undefined ? {} : { secretStore });
  harnesses.push(h);
  return h;
};

const signedInBehindWatch = async (): Promise<{ h: Harness; watched: WatchedStore; generation: number }> => {
  const h = await harness();
  await signedIn(h, 'work');
  const generation = (await readRecord(h, 'work'))?.['generation'] as number;
  const watched = watchedStore(h.store);
  await h.reopen({ store: watched.store });
  return { h, watched, generation };
};

const settledState = (work: Promise<unknown>): (() => 'pending' | 'fulfilled' | 'rejected') => {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  work.then(
    () => {
      state = 'fulfilled';
    },
    () => {
      state = 'rejected';
    },
  );
  return () => state;
};

const rejectionOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => {
      throw new Error('expected a rejection');
    },
    (error: unknown) => error,
  );

const signalOfCall = (watched: WatchedStore, operation: 'read' | 'withKey', index: number): AbortSignal => {
  const call = watched.calls.filter((entry) => entry.operation === operation)[index];
  if (!(call?.signal instanceof AbortSignal)) throw new Error(`the ${operation} call ${index} received no signal`);
  return call.signal;
};

const isRotation = (generation: number) => (value: string) => {
  const record = JSON.parse(value) as { generation?: number; pendingRefresh?: unknown };
  return record.generation === generation + 1 && record.pendingRefresh === undefined;
};

const keychain = (): { store: SecretStore; control: FakeControl } => {
  const items = new Map<string, string>();
  const given: { store: SecretStore; control: FakeControl } = {
    control: { readiness: 'ready', calls: 'answer' },
    store: createKeychainSecretStore(
      createFakeSecurityPort(
        () => Object.fromEntries(items),
        (name, value) => void items.set(name, value),
        { control: () => given.control },
      ),
      SECURITY_BINARY,
      createFakeSecretFiles(() => new Set([KEYCHAIN_PATH])),
    ),
  };
  return given;
};

describe('every plan store call takes the signal of the operation that asked (design-secret-store-unusable 12, rule 1)', () => {
  it('every store.read and store.withKey call receives an AbortSignal', async () => {
    const h = await harness();
    const watched = watchedStore(h.store);
    await h.reopen({ store: watched.store });
    await signedIn(h, 'work');
    const source = h.sessions.authSource(WORK);
    await h.sessions.load(WORK, NEVER_ENDED);
    await h.sessions.registration(WORK, NEVER_ENDED);
    await h.sessions.known(NEVER_ENDED);
    await h.sessions.selectActive(WORK, NEVER_ENDED);
    await source.pause({ code: PAUSE_CODE }, NEVER_ENDED);
    await source.resume(NEVER_ENDED);
    await source.pause({ code: PAUSE_CODE }, NEVER_ENDED);
    await h.sessions.resume(WORK, NEVER_ENDED);
    toRefreshWindow(h, START_MS);
    const { generation } = await source.read(NEVER_ENDED);
    h.clock.advance(60_000);
    await source.rejected(generation, NEVER_ENDED);
    await h.sessions.signOut(WORK, NEVER_ENDED);
    await h.reopen({ store: watched.store, accounts: [WORK] });

    expect(watched.calls.map((call) => call.operation)).toEqual(expect.arrayContaining(['read', 'withKey', 'listKeys']));
    expect(watched.calls.filter((call) => !(call.signal instanceof AbortSignal))).toEqual([]);
  });
});

describe('a shared load is ended only by its last waiter and an abort is never a load result (12, rules 2 and 3)', () => {
  it('a request abort during a hung load leaves the account loadable', async () => {
    const { h, watched } = await signedInBehindWatch();
    const source = h.sessions.authSource(WORK);
    watched.hang.read = true;
    const leaving = new AbortController();
    const reading = rejectionOf(source.read(leaving.signal));
    await expect.poll(() => watched.calls.filter((call) => call.operation === 'read').length, CONDITION_WAIT).toBe(1);
    const reason = new Error('the client went away');
    leaving.abort(reason);

    expect(await reading).toBe(reason);
    expect(signalOfCall(watched, 'read', 0).reason).toBe(reason);
    expect(source.status()).toEqual({ state: 'absent' });
    expect(h.warnings).toEqual([]);

    watched.hang.read = false;
    expect((await source.read(NEVER_ENDED)).bearer).toBeDefined();
    expect(watched.calls.filter((call) => call.operation === 'read')).toHaveLength(2);
    expect(source.status()).toMatchObject({ state: 'active' });
  });

  it('a hung load is ended by its last waiter, with that waiter\'s reason', async () => {
    const { h, watched } = await signedInBehindWatch();
    const source = h.sessions.authSource(WORK);
    watched.hang.read = true;
    const first = new AbortController();
    const second = new AbortController();
    const firstRead = rejectionOf(source.read(first.signal));
    const secondRead = source.read(second.signal);
    const secondState = settledState(secondRead);
    await expect.poll(() => watched.calls.filter((call) => call.operation === 'read').length, CONDITION_WAIT).toBe(1);
    const firstReason = new Error('the first client went away');
    first.abort(firstReason);
    expect(await firstRead).toBe(firstReason);
    expect(signalOfCall(watched, 'read', 0).aborted).toBe(false);
    expect(secondState()).toBe('pending');

    const secondReason = new Error('the second client went away');
    second.abort(secondReason);
    expect(await rejectionOf(secondRead)).toBe(secondReason);
    expect(signalOfCall(watched, 'read', 0).reason).toBe(secondReason);
    expect(watched.calls.filter((call) => call.operation === 'read')).toHaveLength(1);
  });

  it('a limit during a hung load is not a load result', async () => {
    const { h, watched } = await signedInBehindWatch();
    const source = h.sessions.authSource(WORK);
    watched.hang.read = true;
    const limit = operationLimit(NEVER_ENDED, REQUEST_LIMIT_MS, 'the request limit', h.timing);
    const reading = rejectionOf(source.read(limit.signal));
    await expect.poll(() => watched.calls.filter((call) => call.operation === 'read').length, CONDITION_WAIT).toBe(1);
    h.fireLimit(REQUEST_LIMIT_MS);

    const failure = await reading;
    expect(failure).toBeInstanceOf(OperationLimitError);
    expect(limitEndOf(failure)).toEqual({ call: undefined, limit: failure });
    expect(source.status()).toEqual({ state: 'absent' });
    expect(source.health()).not.toMatchObject({ reason: 'store_unreadable' });

    watched.hang.read = false;
    expect((await source.read(NEVER_ENDED)).bearer).toBeDefined();
    expect(source.status()).toMatchObject({ state: 'active' });
  });

  it('a request that meets a hung store ends at the request limit with the limit sentence of the sign-in record store', async () => {
    const { h, watched } = await signedInBehindWatch();
    const source = h.sessions.authSource(WORK);
    watched.hang.read = true;
    const reading = rejectionOf(withinRequestLimit({ limitMs: REQUEST_LIMIT_MS, label: 'the request limit' }, h.timing, NEVER_ENDED, (signal) => source.read(signal)));
    await expect.poll(() => watched.calls.filter((call) => call.operation === 'read').length, CONDITION_WAIT).toBe(1);
    expect(h.pendingLimits()).toEqual([REQUEST_LIMIT_MS]);
    h.fireLimit(REQUEST_LIMIT_MS);

    const failure = await reading;
    expect(failure).toBeInstanceOf(PlanCredentialError);
    expect(failure).toMatchObject({ code: 'plan_credential_unavailable', retryable: false, message: 'the sign-in record store did not finish within the request limit of 300000 ms' });
    expect((failure as Error).cause).toBeInstanceOf(OperationLimitError);
    expect(h.pendingLimits()).toEqual([]);
    expect(source.status()).toEqual({ state: 'absent' });
  });

  it('an abort of the request passes the request limit as the reason itself', async () => {
    const { h, watched } = await signedInBehindWatch();
    const source = h.sessions.authSource(WORK);
    watched.hang.read = true;
    const leaving = new AbortController();
    const reading = rejectionOf(withinRequestLimit({ limitMs: REQUEST_LIMIT_MS, label: 'the request limit' }, h.timing, leaving.signal, (signal) => source.read(signal)));
    await expect.poll(() => watched.calls.filter((call) => call.operation === 'read').length, CONDITION_WAIT).toBe(1);
    const reason = new Error('the client went away');
    leaving.abort(reason);
    expect(await reading).toBe(reason);
    expect(h.pendingLimits()).toEqual([]);
  });
});

describe('a shared refresh is ended only by its last waiter (12, rule 2)', () => {
  it('a request abort during a shared refresh does not end it for the other waiter', async () => {
    const { h, watched, generation } = await signedInBehindWatch();
    const source = h.sessions.authSource(WORK);
    await source.read(NEVER_ENDED);
    toRefreshWindow(h, START_MS);
    const gate = h.holdNextRefresh();
    const leaving = new AbortController();
    const left = rejectionOf(source.read(leaving.signal));
    const staying = source.read(NEVER_ENDED);
    await expect.poll(() => h.fetchUrls.filter((url) => url === h.auth.tokenUrl).length, CONDITION_WAIT).toBe(1);
    const reason = new Error('the client went away');
    leaving.abort(reason);
    expect(await left).toBe(reason);
    const refreshLock = signalOfCall(watched, 'withKey', watched.calls.filter((call) => call.operation === 'withKey').length - 1);
    expect(refreshLock.aborted).toBe(false);
    gate.release();

    expect((await staying).generation).toBe(generation + 1);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    expect((await readRecord(h, 'work'))?.['generation']).toBe(generation + 1);
  });

  it('a refresh waiting for the record lock is ended by its last waiter and the next request starts another', async () => {
    const { h, watched, generation } = await signedInBehindWatch();
    const source = h.sessions.authSource(WORK);
    await source.read(NEVER_ENDED);
    toRefreshWindow(h, START_MS);
    watched.hang.lock = true;
    const locksBefore = watched.calls.filter((call) => call.operation === 'withKey').length;
    const leaving = new AbortController();
    const left = rejectionOf(source.read(leaving.signal));
    await expect.poll(() => watched.calls.filter((call) => call.operation === 'withKey').length, CONDITION_WAIT).toBe(locksBefore + 1);
    const reason = new Error('the client went away');
    leaving.abort(reason);
    expect(await left).toBe(reason);
    expect(signalOfCall(watched, 'withKey', locksBefore).reason).toBe(reason);
    expect(source.status()).toMatchObject({ state: 'active' });
    expect(h.auth.calls.tokenRefreshToken).toBe(0);

    watched.hang.lock = false;
    expect((await source.read(NEVER_ENDED)).generation).toBe(generation + 1);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
  });
});

describe('an abort or a limit is a failed write attempt, never store_unwritable (12, rules 4 and 5)', () => {
  it('an abort during a persist is a failed attempt, not unwritable', async () => {
    const { h, watched, generation } = await signedInBehindWatch();
    const source = h.sessions.authSource(WORK);
    await source.read(NEVER_ENDED);
    toRefreshWindow(h, START_MS);
    watched.hang.write = isRotation(generation);
    const retryWait = h.holdNextBackoff();
    const leaving = new AbortController();
    const left = rejectionOf(source.read(leaving.signal));
    await expect.poll(() => watched.hung, CONDITION_WAIT).toBe(1);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    const reason = new Error('the client went away');
    leaving.abort(reason);
    expect(await left).toBe(reason);
    await retryWait.reached;

    expect(h.sleeps).toContain(PERSIST_RETRY_MS);
    expect(source.status()).toMatchObject({ state: 'active' });
    expect(source.health()).toEqual({ ok: true });
    expect((await readRecord(h, 'work'))?.['generation']).toBe(generation);
    expect((await source.read(NEVER_ENDED)).generation).toBe(generation + 1);

    watched.hang.write = () => false;
    retryWait.release();
    await expect.poll(async () => (await readRecord(h, 'work'))?.['generation'], CONDITION_WAIT).toBe(generation + 1);
    expect(source.status()).toMatchObject({ state: 'active' });
    expect(h.warnings).toEqual([]);
  });

  const dirtyAfterRotation = async (): Promise<{ h: Harness; watched: WatchedStore; generation: number; source: ReturnType<Harness['sessions']['authSource']>; retryWait: ReturnType<Harness['holdNextBackoff']> }> => {
    const { h, watched, generation } = await signedInBehindWatch();
    const source = h.sessions.authSource(WORK);
    await source.read(NEVER_ENDED);
    toRefreshWindow(h, START_MS);
    const rotation = isRotation(generation);
    let refused = false;
    watched.fail.write = (value) => {
      if (refused || !rotation(value)) return undefined;
      refused = true;
      return errno('ENOSPC');
    };
    const retryWait = h.holdNextBackoff();
    expect((await source.read(NEVER_ENDED)).generation).toBe(generation + 1);
    await retryWait.reached;
    return { h, watched, generation, source, retryWait };
  };

  it('a hung persist attempt ends at its limit and is tried again', async () => {
    const { h, watched, generation, source, retryWait } = await dirtyAfterRotation();
    watched.hang.write = isRotation(generation);
    const secondWait = h.holdNextBackoff();
    retryWait.release();
    await expect.poll(() => watched.hung, CONDITION_WAIT).toBe(1);
    expect(h.pendingLimits()).toEqual([PERSIST_LIMIT_MS]);
    h.fireLimit(PERSIST_LIMIT_MS);
    await secondWait.reached;

    expect(h.pendingLimits()).toEqual([]);
    expect(source.status()).toMatchObject({ state: 'active' });
    expect((await readRecord(h, 'work'))?.['generation']).toBe(generation);
    expect(h.sleeps.filter((ms) => ms === PERSIST_RETRY_MS || ms === 2 * PERSIST_RETRY_MS)).toEqual([PERSIST_RETRY_MS, 2 * PERSIST_RETRY_MS]);

    watched.hang.write = () => false;
    secondWait.release();
    await expect.poll(async () => (await readRecord(h, 'work'))?.['generation'], CONDITION_WAIT).toBe(generation + 1);
    expect(source.status()).toMatchObject({ state: 'active' });
    expect(h.warnings).toEqual([]);
  });

  it('an expiry while waiting for the record lock does not make close() throw', async () => {
    const { h, watched, source, retryWait } = await dirtyAfterRotation();
    watched.hang.lock = true;
    const locksBefore = watched.calls.filter((call) => call.operation === 'withKey').length;
    const secondWait = h.holdNextBackoff();
    retryWait.release();
    await expect.poll(() => watched.hung, CONDITION_WAIT).toBe(1);
    expect(h.pendingLimits()).toEqual([PERSIST_LIMIT_MS]);
    h.fireLimit(PERSIST_LIMIT_MS);
    await secondWait.reached;

    const lockReason: unknown = signalOfCall(watched, 'withKey', locksBefore).reason;
    expect(lockReason).toBeInstanceOf(OperationLimitError);
    expect((lockReason as OperationLimitError).message).toBe('the persist limit of 300000 ms passed');
    expect(source.status()).toMatchObject({ state: 'active' });
    expect(h.sleeps.filter((ms) => ms === PERSIST_RETRY_MS || ms === 2 * PERSIST_RETRY_MS)).toEqual([PERSIST_RETRY_MS, 2 * PERSIST_RETRY_MS]);
    expect(h.warnings).toEqual([]);
    await expect(h.sessions.close()).resolves.toBeUndefined();
  });

  it('closing while a persist attempt waits for the record lock is a normal stop', async () => {
    const { h, watched, retryWait } = await dirtyAfterRotation();
    watched.hang.lock = true;
    retryWait.release();
    await expect.poll(() => watched.hung, CONDITION_WAIT).toBe(1);

    await expect(h.sessions.close()).resolves.toBeUndefined();
    expect(h.warnings).toEqual([]);
  });

  it('a record lock wait ended by the signal of its request is that reason, never store_unwritable', async () => {
    const { h, watched } = await signedInBehindWatch();
    const source = h.sessions.authSource(WORK);
    await source.read(NEVER_ENDED);
    watched.hang.lock = true;
    const leaving = new AbortController();
    const pausing = rejectionOf(source.pause({ code: PAUSE_CODE }, leaving.signal));
    const locksBefore = watched.calls.filter((call) => call.operation === 'withKey').length;
    await expect.poll(() => watched.calls.filter((call) => call.operation === 'withKey').length, CONDITION_WAIT).toBe(locksBefore + 1);
    const reason = new Error('the client went away');
    leaving.abort(reason);

    expect(await pausing).toBe(reason);
    expect(source.status()).toEqual({ state: 'active' });
    expect(source.health()).toEqual({ ok: true });
    expect(h.sleeps).not.toContain(PERSIST_RETRY_MS);
  });
});

describe('an absent OS store is the N81 refusal on a plan surface (12, rules 4 and 6)', () => {
  it('an absent store on write marks store_unwritable with the N81 text', async () => {
    const keys = keychain();
    const h = await harness(keys.store);
    await signedIn(h, 'work');
    const source = h.sessions.authSource(WORK);
    await source.read(NEVER_ENDED);
    toRefreshWindow(h, START_MS);
    keys.control = { readiness: 'none', calls: 'answer' };
    await source.read(NEVER_ENDED);

    expect(source.status()).toEqual({ state: 'store_unwritable', cause: NO_STORE_TEXT });
    expect(source.health()).toMatchObject({ ok: false, reason: 'store_unwritable', detail: NO_STORE_TEXT });
    expect(h.auth.calls.tokenRefreshToken).toBe(0);
    expect(h.sleeps).not.toContain(PERSIST_RETRY_MS);
  });

  it('an absent store on load marks store_unreadable with the N81 text', async () => {
    const keys = keychain();
    const h = await harness(keys.store);
    await signedIn(h, 'work');
    await h.reopen();
    const source = h.sessions.authSource(WORK);
    keys.control = { readiness: 'none', calls: 'answer' };

    expect(await planError(source.read(NEVER_ENDED))).toEqual({ code: 'plan_store_unreadable', retryable: false, message: NO_STORE_TEXT });
    expect(source.status()).toEqual({ state: 'store_unreadable', cause: NO_STORE_TEXT });
  });

  it('a key read ended by the limit of its request is not a load result', async () => {
    const keys = keychain();
    const h = await harness(keys.store);
    await signedIn(h, 'work');
    await h.reopen();
    keys.control = { readiness: 'ready', calls: 'hang' };
    const limit = operationLimit(NEVER_ENDED, REQUEST_LIMIT_MS, 'the request limit', h.timing);
    const failure = rejectionOf(h.sessions.registration(WORK, limit.signal));
    await expect.poll(() => h.pendingLimits(), CONDITION_WAIT).toEqual([REQUEST_LIMIT_MS]);
    h.fireLimit(REQUEST_LIMIT_MS);

    expect(await failure).toBeInstanceOf(OperationLimitError);
    expect(h.warnings).toEqual([]);
    keys.control = { readiness: 'ready', calls: 'answer' };
    expect(await h.sessions.registration(WORK, NEVER_ENDED)).toMatchObject({ state: 'active' });
  });
});
