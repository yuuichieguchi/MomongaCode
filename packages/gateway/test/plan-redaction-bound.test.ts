import { afterEach, describe, expect, it } from 'vitest';
import { NEVER_ENDED, PROFILE_ID, START_MS, recordKey, signInAtFake, signedIn, startHarness, toRefreshWindow } from './plan-support.ts';
import type { FakeSignIn, Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const harness = async (): Promise<Harness> => {
  const h = await startHarness();
  harnesses.push(h);
  return h;
};

const KEY = recordKey('work');

const OLDER_ACCESS_TOKENS = 3;
const VALUES_PER_ACCOUNT = 9;

const signInAgain = async (h: Harness, clientId: string): Promise<FakeSignIn> => {
  const again = await signInAtFake(h, { clientId });
  const installed = await h.sessions.install(
    { profile: PROFILE_ID, account: 'work', clientId: again.clientId, hostId: again.hostId, subject: again.subject, email: again.email, idToken: again.idToken, tokens: again.tokens },
    NEVER_ENDED,
  );
  expect(installed.outcome).toBe('signed_in');
  return again;
};

describe('the redactor keeps at most three replaced access tokens and nine values per account (N-G3, G3-9, ST-7)', () => {
  it('seven sign-ins inside one access lifetime: the set never exceeds nine values, and the access token replaced longest ago leaves when a fourth arrives', async () => {
    const h = await harness();
    const signIns: FakeSignIn[] = [await signedIn(h, 'work')];
    for (let index = 1; index < 7; index += 1) {
      h.clock.advance(1000);
      signIns.push(await signInAgain(h, signIns[0]?.clientId ?? ''));
      expect((h.fed.get(KEY) ?? []).length).toBeLessThanOrEqual(VALUES_PER_ACCOUNT);
    }
    const fed = h.fed.get(KEY) ?? [];
    const access = signIns.map((signIn) => signIn.tokens.access_token);
    const older = access.slice(0, -2);
    expect(older.filter((token) => fed.includes(token))).toEqual(older.slice(-OLDER_ACCESS_TOKENS));
    expect(fed).toHaveLength(VALUES_PER_ACCOUNT);
  });

  it('five sign-ins and twenty refreshes: the set stays at or under nine values', async () => {
    const h = await harness();
    const first = await signedIn(h, 'work');
    for (let index = 0; index < 4; index += 1) {
      h.clock.advance(1000);
      await signInAgain(h, first.clientId);
    }
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    let issuedAt = h.clock.now();
    for (let index = 0; index < 20; index += 1) {
      toRefreshWindow(h, issuedAt);
      await source.read(NEVER_ENDED);
      issuedAt = h.clock.now();
      expect((h.fed.get(KEY) ?? []).length).toBeLessThanOrEqual(VALUES_PER_ACCOUNT);
    }
    expect(START_MS).toBeLessThan(issuedAt);
  });
});
