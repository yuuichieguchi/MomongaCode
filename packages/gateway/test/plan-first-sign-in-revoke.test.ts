import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeFileSystem } from '@momonga/foundation';
import { siwcBrowse, testKernelLock } from '@momonga/testkit';
import { createPlanSignIn } from '../src/plan/signin.ts';
import { CONDITION_WAIT, PROFILE_ID, realSleep, startHarness } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const DAY_MS = 86_400_000;

const signInOf = (h: Harness) =>
  createPlanSignIn({
    lock: testKernelLock(),
    profiles: { [PROFILE_ID]: h.profile },
    sessions: h.sessions,
    clock: h.clock,
    outbound: (signal, use) => {
      signal.throwIfAborted();
      return use((url, init) => fetch(url, init));
    },
    lifetime: h.sessions.lifetime,
    sleep: realSleep,
    fileSystem: nodeFileSystem,
    hostFile: h.paths.host,
  });

const unconfirmedAttempt = async (h: Harness, account: string) => {
  const signIn = signInOf(h);
  const { attemptId, authorizationUrl } = await signIn.begin({ profile: PROFILE_ID, account, port: 49152 }, new AbortController().signal);
  const browsed = await siwcBrowse(authorizationUrl);
  const callback = browsed.redirect;
  if (callback === undefined) throw new Error(`the fake refused the authorization: ${JSON.stringify(browsed.body)}`);
  await expect(signIn.complete(attemptId, callback.href, new AbortController().signal)).resolves.toMatchObject({ outcome: 'identity_unconfirmed', attemptId });
  return { signIn, attemptId };
};

describe('the tokens of a first sign-in that is never confirmed are revoked', () => {
  it('cancel revokes the tokens the browser returned', async () => {
    const h = await startHarness();
    harnesses.push(h);
    const { signIn, attemptId } = await unconfirmedAttempt(h, 'work');
    expect(h.auth.calls.revoke).toBe(0);

    expect(signIn.cancel(attemptId)).toBe(true);

    await vi.waitFor(() => expect(h.auth.calls.revoke).toBe(1), CONDITION_WAIT);
  });

  it('an attempt that expires unconfirmed revokes the tokens the browser returned', async () => {
    const h = await startHarness();
    harnesses.push(h);
    const { signIn } = await unconfirmedAttempt(h, 'work');
    expect(h.auth.calls.revoke).toBe(0);

    h.clock.advance(DAY_MS);
    expect(signIn.waiting()).toBe(false);

    await vi.waitFor(() => expect(h.auth.calls.revoke).toBe(1), CONDITION_WAIT);
  });

  it('a new attempt for the same account revokes the tokens of the attempt it replaces', async () => {
    const h = await startHarness();
    harnesses.push(h);
    const { signIn } = await unconfirmedAttempt(h, 'work');
    expect(h.auth.calls.revoke).toBe(0);

    await signIn.begin({ profile: PROFILE_ID, account: 'work', port: 49152 }, new AbortController().signal);

    await vi.waitFor(() => expect(h.auth.calls.revoke).toBe(1), CONDITION_WAIT);
  });
});
