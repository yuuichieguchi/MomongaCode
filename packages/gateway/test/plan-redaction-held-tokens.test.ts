import { afterEach, describe, expect, it } from 'vitest';
import { PROFILE_ID, START_MS, editRecord, planError, readRecord, recordKey, signInAtFake, signedIn, startHarness, toRefreshWindow } from './plan-support.ts';
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

const KEY = recordKey('work');

const work = { profile: PROFILE_ID, account: 'work' };

const signal = (): AbortSignal => new AbortController().signal;

const sorted = (values: readonly string[]): string[] => [...values].sort();

const restarted = async (h: Harness): Promise<void> => {
  h.fed.clear();
  await h.reopen({ accounts: [work] });
  await h.sessions.load(work, new AbortController().signal);
};

const terminallyRefused = async (h: Harness): Promise<void> => {
  h.auth.scriptToken('refresh_token', [{ kind: 'error', code: 'invalid_grant' }]);
  toRefreshWindow(h, START_MS);
  expect((await planError(h.sessions.authSource(work).read(signal()))).code).toBe('sign_in_required');
};

describe('a record that holds any token feeds the redactor from the moment it is loaded (K2)', () => {
  it('after a restart a needs_sign_in record holding only id_token has that token in the set', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    await terminallyRefused(h);
    const record = await readRecord(h, 'work');
    expect({ state: record?.['state'], access: record?.['access_token'], refresh: record?.['refresh_token'], id: record?.['id_token'] }).toEqual({
      state: 'needs_sign_in',
      access: undefined,
      refresh: undefined,
      id: signIn.idToken,
    });
    await restarted(h);
    expect(h.fed.get(KEY)).toEqual([signIn.idToken]);
  });

  it('a loaded record with refresh_token and no access_token has its refresh and ID tokens in the set', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    await editRecord(h, 'work', ({ access_token: _access, expiresAt: _expiresAt, lifetimeMs: _lifetimeMs, ...kept }) => kept);
    await restarted(h);
    expect(sorted(h.fed.get(KEY) ?? [])).toEqual(sorted([String(signIn.tokens.refresh_token), signIn.idToken]));
  });

  it('a sign-in installed over a loaded record that held only id_token keeps that token as the record before: three current values and the one before', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    await terminallyRefused(h);
    await restarted(h);
    const again = await signInAtFake(h, { clientId: signIn.clientId });
    const installed = await h.sessions.install({
      profile: PROFILE_ID,
      account: 'work',
      clientId: again.clientId,
      hostId: again.hostId,
      subject: again.subject,
      email: again.email,
      idToken: again.idToken,
      tokens: again.tokens,
    }, new AbortController().signal);
    expect(installed.outcome).toBe('signed_in');
    expect(sorted(h.fed.get(KEY) ?? [])).toEqual(sorted([again.tokens.access_token, String(again.tokens.refresh_token), again.idToken, signIn.idToken]));
  });

  it('a loaded record with no token feeds nothing', async () => {
    const h = await harness();
    const signIn = await signInAtFake(h);
    expect(await h.sessions.register({ profile: PROFILE_ID, account: 'work', clientId: signIn.clientId, hostId: signIn.hostId }, new AbortController().signal)).toEqual({ outcome: 'registered' });
    await restarted(h);
    expect((await readRecord(h, 'work'))?.['state']).toBe('registered');
    expect(h.fed.has(KEY)).toBe(false);
  });
});
