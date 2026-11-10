import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { PAUSE_CODE, PROFILE_ID, START_MS, planError, rawRecord, readRecord, signInAtFake, signedIn, startHarness, toRefreshWindow } from './plan-support.ts';
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

const installOf = (h: Harness, account: string, signIn: FakeSignIn, change: Partial<Parameters<Harness['sessions']['install']>[0]> = {}) =>
  h.sessions.install({
    profile: PROFILE_ID,
    account,
    clientId: signIn.clientId,
    hostId: signIn.hostId,
    subject: signIn.subject,
    email: signIn.email,
    idToken: signIn.idToken,
    tokens: signIn.tokens,
    ...change,
  });

const activeFile = async (h: Harness): Promise<string | undefined> => {
  try {
    return await fs.readFile(h.paths.active, 'utf8');
  } catch {
    return undefined;
  }
};

describe('register: the compare-and-write of the registered record (I-S4)', () => {
  it('writes a registered record with client id, host id and label when none exists', async () => {
    const h = await harness();
    const signIn = await signInAtFake(h);
    expect(await h.sessions.register({ profile: PROFILE_ID, account: 'work', clientId: signIn.clientId, hostId: signIn.hostId })).toEqual({ outcome: 'registered' });
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'registered', client_id: signIn.clientId, ext_agent_host_id: signIn.hostId, account: 'work', profile: PROFILE_ID });
  });

  it('refuses another client id for an existing record as registration_superseded and leaves the file unchanged', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const before = await rawRecord(h, 'work');
    const other = await signInAtFake(h);
    expect(await h.sessions.register({ profile: PROFILE_ID, account: 'work', clientId: other.clientId, hostId: other.hostId })).toEqual({
      outcome: 'rejected',
      reason: 'registration_superseded',
    });
    expect(await rawRecord(h, 'work')).toBe(before);
  });
});

describe('install: the compare-and-write of the full record (I-C8 IdentityPinned, I-S4, I-S7)', () => {
  it('binds the validated subject, writes generation + 1, and makes the account active', async () => {
    const h = await harness();
    const signIn = await signInAtFake(h);
    await h.sessions.register({ profile: PROFILE_ID, account: 'work', clientId: signIn.clientId, hostId: signIn.hostId });
    const registered = await readRecord(h, 'work');
    expect(await activeFile(h)).toBeUndefined();
    expect(await installOf(h, 'work', signIn)).toMatchObject({ outcome: 'signed_in' });
    const record = await readRecord(h, 'work');
    expect(record).toMatchObject({ state: 'active', subject: signIn.subject, email: signIn.email, client_id: signIn.clientId, access_token: signIn.tokens.access_token, refresh_token: signIn.tokens.refresh_token, id_token: signIn.idToken, version: expect.any(Number) });
    expect(record?.['generation']).toBe(((registered?.['generation'] as number | undefined) ?? 0) + 1);
    expect(JSON.parse((await activeFile(h)) ?? '{}')).toEqual({ [PROFILE_ID]: 'work' });
    expect((await fs.stat(h.paths.active)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(h.paths.sessions)).mode & 0o777).toBe(0o700);
    for (const token of [signIn.tokens.access_token, signIn.tokens.refresh_token, signIn.idToken]) expect(await activeFile(h)).not.toContain(token);
  });

  it('a different subject for a bound account is rejected as registration_superseded; the record and the pointer are unchanged', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    const before = await rawRecord(h, 'work');
    const pointer = await activeFile(h);
    const again = await signInAtFake(h, { clientId: signIn.clientId });
    expect(await installOf(h, 'work', again, { subject: 'sub-someone-else' })).toEqual({ outcome: 'rejected', reason: 'registration_superseded' });
    expect(await rawRecord(h, 'work')).toBe(before);
    expect(await activeFile(h)).toBe(pointer);
  });

  it('an install with another client id than the record holds is rejected and changes nothing', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const before = await rawRecord(h, 'work');
    const other = await signInAtFake(h);
    expect(await installOf(h, 'work', other)).toEqual({ outcome: 'rejected', reason: 'registration_superseded' });
    expect(await rawRecord(h, 'work')).toBe(before);
  });

  it('a returning sign-in with the same subject and client replaces the tokens and keeps the registration', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    const again = await signInAtFake(h, { clientId: signIn.clientId });
    expect(await installOf(h, 'work', again)).toMatchObject({ outcome: 'signed_in' });
    expect(await readRecord(h, 'work')).toMatchObject({ access_token: again.tokens.access_token, refresh_token: again.tokens.refresh_token, client_id: signIn.clientId, subject: signIn.subject });
  });

  it('a granted scope without the required scope installs as plan_disabled (F5) and reads fail with plan_use_not_enabled', async () => {
    const h = await harness();
    h.auth.withheldScopes = ['chatgpt.tokens.use.direct'];
    const signIn = await signInAtFake(h);
    await h.sessions.register({ profile: PROFILE_ID, account: 'work', clientId: signIn.clientId, hostId: signIn.hostId });
    expect(await installOf(h, 'work', signIn)).toMatchObject({ outcome: 'plan_disabled' });
    expect((await readRecord(h, 'work'))?.['state']).toBe('plan_disabled');
    expect((await planError(h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).read(new AbortController().signal))).code).toBe('plan_use_not_enabled');
  });

  it('a token response with no refresh token while offline_access is granted is a protocol error and installs nothing', async () => {
    const h = await harness();
    const signIn = await signInAtFake(h);
    await h.sessions.register({ profile: PROFILE_ID, account: 'work', clientId: signIn.clientId, hostId: signIn.hostId });
    const before = await rawRecord(h, 'work');
    await expect(installOf(h, 'work', signIn, { tokens: { ...signIn.tokens, refresh_token: undefined } as unknown as typeof signIn.tokens })).rejects.toThrow();
    expect(await rawRecord(h, 'work')).toBe(before);
    expect(await activeFile(h)).toBeUndefined();
  });

  it.each([
    ['equal to M', 121],
    ['below M', 30],
    ['of one second', 1],
  ])('a well-formed token response with expires_in %s is installed', async (_name, seconds) => {
    const h = await harness();
    const signIn = await signInAtFake(h);
    await h.sessions.register({ profile: PROFILE_ID, account: 'work', clientId: signIn.clientId, hostId: signIn.hostId });
    expect(await installOf(h, 'work', signIn, { tokens: { ...signIn.tokens, expires_in: seconds } })).toMatchObject({ outcome: 'signed_in' });
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'active', access_token: signIn.tokens.access_token, refresh_token: signIn.tokens.refresh_token });
    expect(JSON.parse((await activeFile(h)) ?? '{}')).toEqual({ [PROFILE_ID]: 'work' });
  });

  it('a new install of a paused account ends the pause', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    await h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).pause({ code: PAUSE_CODE });
    const again = await signInAtFake(h, { clientId: signIn.clientId });
    await installOf(h, 'work', again);
    expect((await h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).read(new AbortController().signal)).bearer).toBe(again.tokens.access_token);
  });
});

describe('two accounts are isolated (AccountsIsolated, OtherAccountsUntouched)', () => {
  it('refresh and sign-out of one account leave the other account file byte for byte', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.auth.identity = { sub: 'sub-second-user', email: 'second@example.com' };
    const home = await signedIn(h, 'home');
    const homeBefore = await rawRecord(h, 'home');
    toRefreshWindow(h, START_MS);
    await h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).read(new AbortController().signal);
    await h.sessions.signOut({ profile: PROFILE_ID, account: 'work' }, new AbortController().signal);
    expect(await rawRecord(h, 'home')).toBe(homeBefore);
    expect(await readRecord(h, 'home')).toMatchObject({ client_id: home.clientId, subject: 'sub-second-user', refresh_token: home.tokens.refresh_token });
  });

  it('selecting an existing account changes only the pointer, touches no record, and refuses an account with no validated install', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.auth.identity = { sub: 'sub-second-user', email: 'second@example.com' };
    await signedIn(h, 'home');
    const records = [await rawRecord(h, 'work'), await rawRecord(h, 'home')];
    await h.sessions.selectActive({ profile: PROFILE_ID, account: 'work' });
    expect(JSON.parse((await activeFile(h)) ?? '{}')).toEqual({ [PROFILE_ID]: 'work' });
    expect([await rawRecord(h, 'work'), await rawRecord(h, 'home')]).toEqual(records);
    await expect(h.sessions.selectActive({ profile: PROFILE_ID, account: 'nobody' })).rejects.toThrow();
    expect(JSON.parse((await activeFile(h)) ?? '{}')).toEqual({ [PROFILE_ID]: 'work' });
  });
});
