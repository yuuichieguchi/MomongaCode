import { afterEach, describe, expect, it } from 'vitest';
import { PLAN_CREDENTIAL_UNAVAILABLE_CODE } from '@momonga/protocol';
import { PROFILE_ID, SECOND, START_MS, editRecord, planError, readRecord, signedIn, startHarness } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const harness = async (): Promise<Harness> => {
  const h = await startHarness();
  harnesses.push(h);
  return h;
};

const readWork = (h: Harness) => h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).read(new AbortController().signal);

const signedInWithLifetime = async (h: Harness, seconds: number) => {
  h.auth.scriptToken('authorization_code', [{ kind: 'expires_in', seconds }]);
  return signedIn(h, 'work');
};

describe('refreshes of one account are at least S = 60 s apart (P-R)', () => {
  it('with expires_in 100 a read at age 1 s does not refresh and serves the token', async () => {
    const h = await harness();
    const signIn = await signedInWithLifetime(h, 100);
    h.clock.set(START_MS + 1 * SECOND);
    const read = await readWork(h);
    expect(h.auth.calls.tokenRefreshToken).toBe(0);
    expect(read.bearer).toBe(signIn.tokens.access_token);
  });

  it('with expires_in 100 the token is served until age 39 s, reads at ages 40 s to 59 s fail without a send, and the refresh starts at age 60 s', async () => {
    const h = await harness();
    const signIn = await signedInWithLifetime(h, 100);
    h.auth.scriptToken('refresh_token', [{ kind: 'expires_in', seconds: 100 }, { kind: 'expires_in', seconds: 100 }]);
    const unavailable = { code: PLAN_CREDENTIAL_UNAVAILABLE_CODE, retryable: true, message: 'the plan access token could not be refreshed; try again' };
    const tokenPosts = (): number => h.fetchUrls.filter((url) => url === h.auth.tokenUrl).length;
    const at = (second: number): void => h.clock.set(START_MS + second * SECOND);
    for (let second = 1; second <= 39; second += 1) {
      at(second);
      expect({ second, bearer: (await readWork(h)).bearer }).toEqual({ second, bearer: signIn.tokens.access_token });
    }
    expect(h.auth.calls.tokenRefreshToken).toBe(0);
    for (let second = 40; second <= 59; second += 1) {
      at(second);
      expect({ second, failure: await planError(readWork(h)) }).toEqual({ second, failure: unavailable });
    }
    expect(h.auth.calls.tokenRefreshToken).toBe(0);
    expect(tokenPosts()).toBe(0);
    at(60);
    const refreshed = await readWork(h);
    expect(refreshed.bearer).not.toBe(signIn.tokens.access_token);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    at(61);
    expect((await readWork(h)).bearer).toBe(refreshed.bearer);
    at(99);
    expect((await readWork(h)).bearer).toBe(refreshed.bearer);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    at(100);
    expect(await planError(readWork(h))).toEqual(unavailable);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
  });

  it('with expires_in 90 a read between remaining 60 and age 60 fails plan_credential_unavailable without a refresh; at age 60 one refresh runs', async () => {
    const h = await harness();
    await signedInWithLifetime(h, 90);
    h.clock.set(START_MS + 45 * SECOND);
    const failure = await planError(readWork(h));
    expect(failure).toMatchObject({ code: PLAN_CREDENTIAL_UNAVAILABLE_CODE, retryable: true });
    expect(h.auth.calls.tokenRefreshToken).toBe(0);
    h.clock.set(START_MS + 60 * SECOND);
    await readWork(h);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
  });

  it('with expires_in 50 (never usable) reads every second over 100 s of clock time cause exactly 1 refresh, at t = 60 s', async () => {
    const h = await harness();
    await signedInWithLifetime(h, 50);
    h.auth.scriptToken('refresh_token', [{ kind: 'expires_in', seconds: 50 }, { kind: 'expires_in', seconds: 50 }, { kind: 'expires_in', seconds: 50 }]);
    const refreshAt: number[] = [];
    for (let second = 1; second <= 100; second += 1) {
      h.clock.set(START_MS + second * SECOND);
      const before = h.auth.calls.tokenRefreshToken;
      await readWork(h).catch(() => undefined);
      if (h.auth.calls.tokenRefreshToken > before) refreshAt.push(second);
    }
    expect(refreshAt).toEqual([60]);
  });

  it('with expires_in 3600 the first refresh still starts at remaining 121', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.clock.set(START_MS + (3600 - 121) * SECOND - 1);
    await readWork(h);
    expect(h.auth.calls.tokenRefreshToken).toBe(0);
    h.clock.set(START_MS + (3600 - 121) * SECOND);
    await readWork(h);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
  });

  it('the record keeps lifetimeMs across a restart, and a record without it behaves with threshold M', async () => {
    const h = await harness();
    await signedInWithLifetime(h, 100);
    expect((await readRecord(h, 'work'))?.['lifetimeMs']).toBe(100 * SECOND);
    await h.reopen({ accounts: [{ profile: PROFILE_ID, account: 'work' }] });
    h.clock.set(START_MS + 1 * SECOND);
    await readWork(h);
    expect(h.auth.calls.tokenRefreshToken).toBe(0);
    await editRecord(h, 'work', ({ lifetimeMs: _dropped, ...rest }) => rest);
    await h.reopen({ accounts: [{ profile: PROFILE_ID, account: 'work' }] });
    await readWork(h);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
  });
});
