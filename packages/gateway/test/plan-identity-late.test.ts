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

describe('a late identity confirmation names its own refusal', () => {
  it('confirm after the attempt has ended refuses with identity_late, not the expired-attempt text, and revokes the held tokens', async () => {
    const h = await startHarness();
    harnesses.push(h);
    const signIn = createPlanSignIn({
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
    const { attemptId, authorizationUrl } = await signIn.begin({ profile: PROFILE_ID, account: 'work', port: 49152 }, new AbortController().signal);
    const browsed = await siwcBrowse(authorizationUrl);
    const callback = browsed.redirect;
    if (callback === undefined) throw new Error(`the fake refused the authorization: ${JSON.stringify(browsed.body)}`);
    await expect(signIn.complete(attemptId, callback.href, new AbortController().signal)).resolves.toMatchObject({ outcome: 'identity_unconfirmed', attemptId });

    h.clock.advance(DAY_MS);

    await expect(signIn.confirm(attemptId, new AbortController().signal)).rejects.toMatchObject({
      body: { code: 'identity_late' },
      message: expect.stringContaining('arrived after this sign-in attempt had ended'),
    });
    await vi.waitFor(() => expect(h.auth.calls.revoke).toBe(1), CONDITION_WAIT);
  });
});
