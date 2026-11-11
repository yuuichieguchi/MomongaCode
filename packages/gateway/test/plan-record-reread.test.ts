import fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanSessions } from '../src/plan/session.ts';
import { CONDITION_WAIT, PAUSE_CODE, PROFILE_ID, START_MS, errno, failingWrites, planError, readRecord, recordFileOf, signInAtFake, signedIn, startHarness, toRefreshWindow } from './plan-support.ts';
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

const REVOKE_PATH = '/api/accounts/oauth/revoke';

const TEN_MINUTES_MS = 600_000;

const signInAgain = async (h: Harness, sessions: PlanSessions, first: FakeSignIn): Promise<FakeSignIn> => {
  const again = await signInAtFake(h, { clientId: first.clientId });
  const installed = await sessions.install(
    { profile: PROFILE_ID, account: 'work', clientId: again.clientId, hostId: again.hostId, subject: again.subject, email: again.email, idToken: again.idToken, tokens: again.tokens },
    signal(),
  );
  expect(installed).toMatchObject({ outcome: 'signed_in' });
  return again;
};

const twoGenerations = async (): Promise<{ h: Harness; first: FakeSignIn; older: PlanSessions; newer: PlanSessions }> => {
  const h = await harness();
  const first = await signedIn(h, 'work');
  const older = await h.another({ accounts: [work] });
  expect(older.authSource(work).status().state).toBe('active');
  return { h, first, older, newer: h.sessions };
};

const revokedTokens = (h: Harness): Array<string | undefined> => h.auth.records.filter((record) => record.path === REVOKE_PATH).map((record) => record.form['token']);

describe('every refresh, sign-in and sign-out re-reads the record under its lock, whichever generation does it (C47)', () => {
  it('a refresh in the older generation after a sign-in in the newer one sends nothing and serves the new tokens', async () => {
    const { h, first, older, newer } = await twoGenerations();
    toRefreshWindow(h, START_MS);
    const again = await signInAgain(h, newer, first);
    const read = await older.authSource(work).read(signal());
    expect(read.bearer).toBe(again.tokens.access_token);
    expect(h.auth.calls.tokenRefreshToken).toBe(0);
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'active', generation: 2, access_token: again.tokens.access_token, refresh_token: again.tokens.refresh_token });
  });

  it('a refresh in the older generation after a refresh in the newer one sends nothing and serves the refreshed token', async () => {
    const { h, older, newer } = await twoGenerations();
    toRefreshWindow(h, START_MS);
    const refreshed = await newer.authSource(work).read(signal());
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    const read = await older.authSource(work).read(signal());
    expect(read).toEqual(refreshed);
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'active', generation: 2, access_token: refreshed.bearer });
  });

  it('a refresh in the older generation after a sign-out in the newer one sends nothing and leaves the record signed out', async () => {
    const { h, older, newer } = await twoGenerations();
    await newer.signOut(work, signal());
    toRefreshWindow(h, START_MS);
    expect((await planError(older.authSource(work).read(signal()))).code).toBe('sign_in_required');
    expect(h.auth.calls.tokenRefreshToken).toBe(0);
    expect((await readRecord(h, 'work'))?.['state']).toBe('registered');
  });

  it('a rejected token in the older generation after a sign-in in the newer one is renewed by the record on disk, with no request', async () => {
    const { h, first, older, newer } = await twoGenerations();
    h.clock.set(START_MS + TEN_MINUTES_MS);
    const again = await signInAgain(h, newer, first);
    const source = older.authSource(work);
    expect(await source.rejected(1, signal())).toBe('renewed');
    expect(h.auth.calls.tokenRefreshToken).toBe(0);
    expect((await source.read(signal())).bearer).toBe(again.tokens.access_token);
  });

  it('a sign-out in the older generation after a sign-in in the newer one revokes the refresh token the record holds now', async () => {
    const { h, first, older, newer } = await twoGenerations();
    const again = await signInAgain(h, newer, first);
    await older.signOut(work, signal());
    expect(revokedTokens(h)).toEqual([again.tokens.refresh_token]);
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'registered', generation: 2 });
  });

  it('a sign-in in the older generation after a sign-out and a new registration in the newer one is refused and leaves the record as it is', async () => {
    const { h, first, older, newer } = await twoGenerations();
    await newer.signOut(work, signal());
    const other = await signInAtFake(h);
    await fs.rm(recordFileOf(h, 'work'));
    await h.reopen();
    expect(await h.sessions.register({ profile: PROFILE_ID, account: 'work', clientId: other.clientId, hostId: other.hostId }, signal())).toEqual({ outcome: 'registered' });
    const again = await signInAtFake(h, { clientId: first.clientId });
    const installed = await older.install(
      { profile: PROFILE_ID, account: 'work', clientId: again.clientId, hostId: again.hostId, subject: again.subject, email: again.email, idToken: again.idToken, tokens: again.tokens },
      signal(),
    );
    expect(installed).toEqual({ outcome: 'rejected', reason: 'registration_superseded' });
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'registered', client_id: other.clientId });
    expect(older.authSource(work).status().state).toBe('registered');
  });

  it('a change the older generation could not save is not written over a record the newer one wrote since', { timeout: 60_000 }, async () => {
    const h = await harness();
    const first = await signedIn(h, 'work');
    let failing = true;
    const older = await h.another({ accounts: [work], store: failingWrites(h.store, () => (failing ? errno('ENOSPC') : undefined)) });
    const retry = h.holdNextBackoff();
    await older.authSource(work).pause({ code: PAUSE_CODE }, signal());
    expect(older.authSource(work).status().paused).toEqual({});
    await retry.reached;
    const again = await signInAgain(h, h.sessions, first);
    failing = false;
    retry.release();
    await vi.waitFor(() => expect(older.authSource(work).status().paused).toBeUndefined(), CONDITION_WAIT);
    const record = await readRecord(h, 'work');
    expect(record).toMatchObject({ state: 'active', generation: 2, access_token: again.tokens.access_token });
    expect(record?.['paused']).toBeUndefined();
  });

  it('a change of the active account keeps what another generation wrote to the active account file', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.auth.identity = { sub: 'sub-second-user', email: 'second@example.com' };
    await signedIn(h, 'home');
    await fs.writeFile(h.paths.active, JSON.stringify({ [PROFILE_ID]: 'home', team: 'shared' }));
    await h.sessions.selectActive(work, signal());
    expect(JSON.parse(await fs.readFile(h.paths.active, 'utf8'))).toEqual({ [PROFILE_ID]: 'work', team: 'shared' });
    expect(h.sessions.activeLabel(PROFILE_ID)).toBe('work');
  });
});
