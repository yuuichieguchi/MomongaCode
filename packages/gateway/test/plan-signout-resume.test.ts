import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONDITION_WAIT, PROFILE_ID, errno, failingWrites, holdingOneWrite, readRecord, signInAtFake, signedIn, startHarness, writeSigningOut } from './plan-support.ts';
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

const work = { profile: PROFILE_ID, account: 'work' };

const signal = (): AbortSignal => new AbortController().signal;

const stateOf = async (h: Harness): Promise<unknown> => (await readRecord(h, 'work'))?.['state'];

const signOutEnds = (h: Harness): unknown[] => h.events.filter((event) => event.name === 'plan.sign_out').map((event) => event.data['end']);

const UNFINISHED = 'the sign-out of chatgpt account work did not finish: d5 down; it is resumed at the next load';

const isState = (state: string) => (value: string): boolean => (JSON.parse(value) as Record<string, unknown>)['state'] === state;

const failOnce = (matches: (value: string) => boolean) => {
  let remaining = 1;
  return (value: string) => {
    if (remaining === 0 || !matches(value)) return undefined;
    remaining -= 1;
    return errno('EACCES');
  };
};

describe('a sign-out that ends without the cleared record is resumed at the next load, whatever started it (P-S11)', () => {
  it('a resumed sign-out whose D5 acquire fails is resumed at the next load', { timeout: 60_000 }, async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await writeSigningOut(h, 'work');
    h.failNextOutbound(new Error('d5 down'));
    await h.reopen({ accounts: [work] });
    await vi.waitFor(() => expect(h.events.some((event) => event.name === 'plan.sign_out' && event.data['end'] === 'interrupted')).toBe(true), CONDITION_WAIT);
    await h.sessions.known(new AbortController().signal);
    await vi.waitFor(async () => expect(await stateOf(h)).toBe('registered'), CONDITION_WAIT);
    expect(h.fetchUrls).toContain(h.auth.revokeUrl);
  });

  it('close() does not throw when a resumed sign-out failed before revoking', { timeout: 60_000 }, async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await writeSigningOut(h, 'work');
    h.failNextOutbound(new Error('d5 down'));
    await h.reopen({ accounts: [work] });
    await vi.waitFor(() => expect(h.warnings).toContain(UNFINISHED), CONDITION_WAIT);
    await expect(h.sessions.close()).resolves.toBeUndefined();
  });

  it('a sign-out whose cleared-record write fails after a confirmed revocation leaves the account to be resumed at its next load', { timeout: 60_000 }, async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await h.reopen({ accounts: [work], store: failingWrites(h.store, failOnce(isState('registered'))) });
    await expect(h.sessions.signOut(work, signal())).rejects.toThrow();
    expect(await stateOf(h)).toBe('signing_out');
    await h.sessions.known(new AbortController().signal);
    await vi.waitFor(async () => expect(await stateOf(h)).toBe('registered'), CONDITION_WAIT);
  });

  it('a revocation stopped by the lifetime signal leaves signing_out on disk and the next process resumes it', { timeout: 60_000 }, async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.auth.scriptRevoke([{ kind: 'http', status: 503 }]);
    const gate = h.holdNextBackoff();
    const signingOut = h.sessions.signOut(work, signal()).catch(() => undefined);
    await gate.reached;
    let closed = false;
    const closing = h.sessions.close().then(() => {
      closed = true;
    });
    try {
      await vi.waitFor(() => expect(closed).toBe(true), CONDITION_WAIT);
    } finally {
      gate.release();
      await closing.catch(() => undefined);
      await signingOut;
    }
    expect(await stateOf(h)).toBe('signing_out');
    await h.reopen({ accounts: [work] });
    await vi.waitFor(async () => expect(await stateOf(h)).toBe('registered'), CONDITION_WAIT);
  });

  it('a route-started sign-out whose signing_out write fails does not leave the account signing_out', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await h.reopen({ accounts: [work], store: failingWrites(h.store, (value) => (isState('signing_out')(value) ? errno('EACCES') : undefined)) });
    await expect(h.sessions.signOut(work, signal())).rejects.toThrow();
    expect(h.sessions.authSource(work).status().state).toBe('active');
    expect(await stateOf(h)).toBe('active');
  });

  it('after the failure the plan.sign_out event has end interrupted or failed', { timeout: 60_000 }, async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await h.reopen({ accounts: [work], store: failingWrites(h.store, failOnce(isState('signing_out'))) });
    await expect(h.sessions.signOut(work, signal())).rejects.toThrow();
    expect(signOutEnds(h)).toEqual(['failed']);
    await writeSigningOut(h, 'work');
    h.failNextOutbound(new Error('d5 down'));
    await h.reopen({ accounts: [work] });
    await vi.waitFor(() => expect(signOutEnds(h)).toEqual(['failed', 'interrupted']), CONDITION_WAIT);
  });
});

const REVOKE_PATH = '/api/accounts/oauth/revoke';

const revokedTokens = (h: Harness): Array<string | undefined> => h.auth.records.filter((record) => record.path === REVOKE_PATH).map((record) => record.form['token']);

type Overtaken = { again: FakeSignIn; release(): void; resumedHasAsked(): Promise<void> };

const signInOverTheUnfinishedSignOut = async (h: Harness): Promise<Overtaken> => {
  const first = await signedIn(h, 'work');
  await writeSigningOut(h, 'work');
  const resumed = h.delayNextOutbound();
  const counted = holdingOneWrite(h.store, () => false);
  await h.reopen({ accounts: [work], store: counted.store });
  await resumed.reached;
  const again = await signInAtFake(h, { clientId: first.clientId });
  const installed = await h.sessions.install(
    { profile: PROFILE_ID, account: 'work', clientId: again.clientId, hostId: again.hostId, subject: again.subject, email: again.email, idToken: again.idToken, tokens: again.tokens },
    signal(),
  );
  expect(installed).toMatchObject({ outcome: 'signed_in' });
  const before = counted.lockRequests();
  return {
    again,
    release: resumed.release,
    resumedHasAsked: async () => {
      await vi.waitFor(() => expect(counted.lockRequests()).toBeGreaterThan(before), CONDITION_WAIT);
    },
  };
};

describe('a resumed sign-out acts only on the record it finds under the lock (F15)', () => {
  it('a resumed sign-out that finds the sign-in completed meanwhile sends nothing, changes nothing and writes no event', async () => {
    const h = await harness();
    const { again, release, resumedHasAsked } = await signInOverTheUnfinishedSignOut(h);
    release();
    await resumedHasAsked();
    await h.sessions.authSource(work).resume(signal());
    expect(revokedTokens(h)).toEqual([]);
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'active', access_token: again.tokens.access_token, refresh_token: again.tokens.refresh_token });
    expect(h.sessions.authSource(work).status().state).toBe('active');
    expect(signOutEnds(h)).toEqual([]);
    expect(h.warnings.filter((warning) => warning.includes('did not finish'))).toEqual([]);
  });

  it('a sign-out asked for while the resumed one waits signs the new sign-in out itself when the resumed one finds nothing to finish', async () => {
    const h = await harness();
    const { again, release } = await signInOverTheUnfinishedSignOut(h);
    const asked = h.sessions.signOut(work, signal());
    release();
    expect(await asked).toEqual({ revocation: 'confirmed', usageUrl: h.profile.usageUrl });
    expect(revokedTokens(h)).toEqual([again.tokens.refresh_token]);
    expect(await stateOf(h)).toBe('registered');
    expect(h.events.filter((event) => event.name === 'plan.sign_out').map((event) => event.data)).toEqual([
      { profile: PROFILE_ID, account: 'work', resumed: false, end: 'cleared', revocation: 'confirmed' },
    ]);
  });
});
