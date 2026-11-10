import { afterEach, describe, expect, it } from 'vitest';
import { nodeFileSystem } from '@momonga/foundation';
import { siwcBrowse } from '@momonga/testkit';
import { createPlanSignIn } from '../src/plan/signin.ts';
import { PROFILE_ID, realSleep, startHarness } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

describe('O-R5-6 (M) 2.4: the acquire comes before the first irreversible step of complete', () => {
  it("complete under an already aborted signal rejects with that signal's reason, consumes nothing and writes nothing", async () => {
    const h = await startHarness();
    harnesses.push(h);
    const signIn = createPlanSignIn({
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
    const reason = new Error('the request went away');
    const controller = new AbortController();
    controller.abort(reason);

    await expect(signIn.complete(attemptId, callback.href, controller.signal)).rejects.toBe(reason);
    expect(await h.sessions.registration({ profile: PROFILE_ID, account: 'work' }, new AbortController().signal)).toBeUndefined();
    expect(h.auth.calls.tokenAuthorizationCode).toBe(0);
    expect(signIn.waiting()).toBe(true);

    await expect(signIn.complete(attemptId, callback.href, new AbortController().signal)).resolves.toMatchObject({
      outcome: 'signed_in',
      ref: { profile: PROFILE_ID, account: 'work' },
      firstSignIn: true,
    });
  });
});
