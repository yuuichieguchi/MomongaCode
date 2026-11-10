import { afterEach, describe, expect, it } from 'vitest';
import { PROFILE_ID, SKEW_MS, signedIn, startHarness, CONDITION_WAIT } from './plan-support.ts';
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

const signal = (): AbortSignal => new AbortController().signal;

describe('rejected(generation): one forced refresh per generation per process (I-C9, Coalesced)', () => {
  it('runs one forced refresh for the current generation and answers renewed with a newer bearer', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    h.clock.advance(SKEW_MS);
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    const first = await source.read(signal());
    expect(await source.rejected(first.generation, signal())).toBe('renewed');
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    const second = await source.read(signal());
    expect(second.generation).toBe(first.generation + 1);
    expect(second.bearer).not.toBe(signIn.tokens.access_token);
  });

  it('coalesces concurrent 401s on one generation into one forced refresh', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.clock.advance(SKEW_MS);
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    const { generation } = await source.read(signal());
    const answers = await Promise.all([1, 2, 3, 4, 5].map(() => source.rejected(generation, signal())));
    expect(answers).toEqual(['renewed', 'renewed', 'renewed', 'renewed', 'renewed']);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
  });

  it('a later 401 on an old generation answers renewed without another refresh', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.clock.advance(SKEW_MS);
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    const { generation } = await source.read(signal());
    await source.rejected(generation, signal());
    expect(await source.rejected(generation, signal())).toBe('renewed');
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
  });

  it('after a forced refresh that failed transiently, the same generation answers unchanged and sends nothing more', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.clock.advance(SKEW_MS);
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    const { generation } = await source.read(signal());
    h.auth.scriptToken('refresh_token', [{ kind: 'drop' }, { kind: 'drop' }, { kind: 'drop' }]);
    expect(await source.rejected(generation, signal())).toBe('unchanged');
    expect(h.auth.calls.tokenRefreshToken).toBe(3);
    expect(await source.rejected(generation, signal())).toBe('unchanged');
    expect(h.auth.calls.tokenRefreshToken).toBe(3);
  });

  it('a 401 on the new generation runs a new forced refresh', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.clock.advance(SKEW_MS);
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    const { generation } = await source.read(signal());
    await source.rejected(generation, signal());
    h.clock.advance(SKEW_MS);
    expect(await source.rejected(generation + 1, signal())).toBe('renewed');
    expect(h.auth.calls.tokenRefreshToken).toBe(2);
  });

  it('a forced refresh answered with a terminal code answers unchanged and the session needs a sign-in', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.clock.advance(SKEW_MS);
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    const { generation } = await source.read(signal());
    h.auth.scriptToken('refresh_token', [{ kind: 'error', code: 'refresh_token_invalidated' }]);
    expect(await source.rejected(generation, signal())).toBe('unchanged');
    expect(source.status()).toMatchObject({ state: 'needs_sign_in', cause: 'refresh_token_invalidated' });
  });

  it('an abort of the caller cancels only its wait; the refresh it joined still completes', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.clock.advance(SKEW_MS);
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    const { generation } = await source.read(signal());
    const gate = h.holdNextRefresh();
    const controller = new AbortController();
    const aborted = source.rejected(generation, controller.signal);
    const joined = source.rejected(generation, signal());
    await expect.poll(() => h.fetchUrls.filter((url) => url === h.auth.tokenUrl).length, CONDITION_WAIT).toBe(1);
    controller.abort();
    gate.release();
    const [, joinedResult] = await Promise.allSettled([aborted, joined]);
    expect(joinedResult).toEqual({ status: 'fulfilled', value: 'renewed' });
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    expect((await source.read(signal())).generation).toBe(generation + 1);
  });

  it('a 401 on a token younger than 60 s answers unchanged and sends no refresh; after advance(60 000) the same 401 renews once', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    const { generation } = await source.read(signal());
    expect(await source.rejected(generation, signal())).toBe('unchanged');
    expect(h.auth.calls.tokenRefreshToken).toBe(0);
    h.clock.advance(SKEW_MS);
    expect(await source.rejected(generation, signal())).toBe('renewed');
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
  });
});
