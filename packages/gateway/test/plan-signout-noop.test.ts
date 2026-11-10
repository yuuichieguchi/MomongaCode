import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { credentialFileFor } from '@momonga/foundation';
import { PLAN_ROUTES } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { ACCOUNT, recordingLogger, sessionsDirectory, signIn, startPlanGateway } from './plan-signin-support.ts';
import type { RecordedEvent } from './plan-signin-support.ts';
import { CONDITION_WAIT, PROFILE_ID, editRecord, rawRecord, readRecord, recordingSignal, signInAtFake, signedIn, startHarness, writeSigningOut } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

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

const signOut = (h: Harness) => h.sessions.signOut(work, new AbortController().signal);

const signOutEvents = (h: Harness): Array<Record<string, unknown>> => h.events.filter((event) => event.name === 'plan.sign_out').map((event) => event.data);

const named = (events: readonly RecordedEvent[], name: string): RecordedEvent[] => events.filter((event) => event.name === name);

const withoutTokens = ({ access_token: _access, refresh_token: _refresh, expiresAt: _expiresAt, ...rest }: Record<string, unknown>): Record<string, unknown> => rest;

describe('a sign-out acts on the record it finds: an account with nothing to sign out is a no-op (P-SO)', () => {
  it('a sign-out of a label with no record answers 404 plan_account_not_found, sends nothing and writes no event', async () => {
    const events: RecordedEvent[] = [];
    const gateway = await startPlanGateway({ logger: recordingLogger(events) });
    try {
      const answered = await gateway.post(PLAN_ROUTES.signOut, { profile: PROFILE_ID, account: 'nobody' });
      expect(answered.status).toBe(404);
      expect(answered.body.error.code).toBe('plan_account_not_found');
      expect(gateway.auth.calls.revoke).toBe(0);
      expect(named(events, 'plan.sign_out')).toEqual([]);
      const listed = await gateway.get(PLAN_ROUTES.accounts);
      expect((listed.body.accounts as { label: string }[]).map((entry) => entry.label)).not.toContain('nobody');
    } finally {
      await gateway.close();
    }
  });

  it('a sign-out of a registered record sends nothing, writes nothing and no event', async () => {
    const h = await harness();
    const signedInAtFake = await signInAtFake(h);
    expect(await h.sessions.register({ profile: PROFILE_ID, account: 'work', clientId: signedInAtFake.clientId, hostId: signedInAtFake.hostId })).toEqual({ outcome: 'registered' });
    const before = await rawRecord(h, 'work');
    expect(before).toBeTypeOf('string');
    expect(await signOut(h)).toEqual({ revocation: 'none', usageUrl: h.profile.usageUrl });
    expect(h.fetchUrls).toEqual([]);
    expect(h.auth.calls.revoke).toBe(0);
    expect(await rawRecord(h, 'work')).toBe(before);
    expect(signOutEvents(h)).toEqual([]);
  });

  it('a second sign-out in one process is the same no-op', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    expect(await signOut(h)).toEqual({ revocation: 'confirmed', usageUrl: h.profile.usageUrl });
    const cleared = await rawRecord(h, 'work');
    expect(await signOut(h)).toEqual({ revocation: 'none', usageUrl: h.profile.usageUrl });
    expect(h.auth.calls.revoke).toBe(1);
    expect(signOutEvents(h)).toHaveLength(1);
    expect(await rawRecord(h, 'work')).toBe(cleared);
  });

  it('a sign-out after a restart is the same no-op', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    expect(await signOut(h)).toEqual({ revocation: 'confirmed', usageUrl: h.profile.usageUrl });
    const cleared = await rawRecord(h, 'work');
    await h.reopen({ accounts: [work] });
    expect(await signOut(h)).toEqual({ revocation: 'none', usageUrl: h.profile.usageUrl });
    expect(h.auth.calls.revoke).toBe(1);
    expect(signOutEvents(h)).toHaveLength(1);
    expect(await rawRecord(h, 'work')).toBe(cleared);
  });

  it('a route sign-out after the resumed sign-out finished answers 200 none and changes nothing', async () => {
    const events: RecordedEvent[] = [];
    const gateway = await startPlanGateway({ plaintextTokenFiles: true, logger: recordingLogger(events) });
    try {
      await signIn(gateway);
      await gateway.close();
      const file = credentialFileFor(sessionsDirectory(gateway.home), `plan/${PROFILE_ID}/${ACCOUNT}`);
      const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(file, JSON.stringify({ ...record, state: 'signing_out' }), { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      await gateway.restart();
      await vi.waitFor(() => expect(named(events, 'plan.sign_out')).toHaveLength(1), CONDITION_WAIT);
      const cleared = fs.readFileSync(file, 'utf8');
      const answered = await gateway.post(PLAN_ROUTES.signOut, { profile: PROFILE_ID, account: ACCOUNT });
      expect(answered.status).toBe(200);
      expect(answered.body.revocation).toBe('none');
      expect(answered.body.usageUrl).toBeTypeOf('string');
      expect(gateway.auth.calls.revoke).toBe(1);
      expect(named(events, 'plan.sign_out').map((event) => ({ resumed: event.data['resumed'], revocation: event.data['revocation'] }))).toEqual([{ resumed: true, revocation: 'confirmed' }]);
      expect(fs.readFileSync(file, 'utf8')).toBe(cleared);
    } finally {
      await gateway.close();
    }
  });

  it('a sign-out of needs_sign_in without a refresh token clears the record, sends nothing and reports unconfirmed', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await editRecord(h, 'work', (record) => ({ ...withoutTokens(record), state: 'needs_sign_in', cause: 'refresh_token_expired' }));
    await h.reopen({ accounts: [work] });
    expect(await signOut(h)).toEqual({ revocation: 'unconfirmed', usageUrl: h.profile.usageUrl });
    expect(h.auth.calls.revoke).toBe(0);
    expect((await readRecord(h, 'work'))?.['state']).toBe('registered');
    expect(signOutEvents(h)).toEqual([{ profile: PROFILE_ID, account: 'work', end: 'cleared', revocation: 'unconfirmed', resumed: false }]);
  });

  it('a sign-out of needs_sign_in with a refresh token revokes it and reports confirmed', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await editRecord(h, 'work', (record) => ({ ...record, state: 'needs_sign_in', cause: 'invalid_client' }));
    await h.reopen({ accounts: [work] });
    expect(await signOut(h)).toEqual({ revocation: 'confirmed', usageUrl: h.profile.usageUrl });
    expect(h.auth.calls.revoke).toBe(1);
    expect(signOutEvents(h)).toEqual([{ profile: PROFILE_ID, account: 'work', end: 'cleared', revocation: 'confirmed', resumed: false }]);
  });

  it('a sign-out request that arrives while the resumed sign-out is in progress joins it', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await writeSigningOut(h, 'work');
    let reach = (): void => undefined;
    let release = (): void => undefined;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.auth.scriptRevoke([{ kind: 'hold', reached: reach, released }]);
    try {
      await h.reopen({ accounts: [work] });
      await reached;
      const joined = recordingSignal();
      const request = h.sessions.signOut(work, joined.signal);
      try {
        await vi.waitFor(() => expect(joined.listeners()).toBe(1), CONDITION_WAIT);
      } finally {
        release();
      }
      expect(await request).toEqual({ revocation: 'confirmed', usageUrl: h.profile.usageUrl });
    } finally {
      release();
    }
    expect(h.auth.calls.revoke).toBe(1);
    expect(signOutEvents(h)).toEqual([{ profile: PROFILE_ID, account: 'work', resumed: true, end: 'cleared', revocation: 'confirmed' }]);
  });
});
