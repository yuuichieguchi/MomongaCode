import fs from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { PROFILE_ID, editRecord, planError, readRecord, signedIn, startHarness } from './plan-support.ts';
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

const twoAccounts = async (h: Harness) => {
  const work = await signedIn(h, 'work');
  h.auth.identity = { sub: 'sub-second-user', email: 'second@example.com' };
  const home = await signedIn(h, 'home');
  return { work, home };
};

const pointTo = (h: Harness, account: string) => fs.writeFile(h.paths.active, JSON.stringify({ [PROFILE_ID]: account }), { mode: 0o600 });

describe('the account pause of M7 is one rule on the AuthSource', () => {
  it('pauses every target on the account: reads fail at once with plan_usage_paused and the usage-limit sentence, and nothing is sent', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const pinnedSource = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    const activeSource = h.sessions.authSource({ profile: PROFILE_ID });
    await activeSource.read(signal());
    await pinnedSource.pause({});
    const urlsBefore = h.fetchUrls.length;
    for (const source of [pinnedSource, activeSource]) {
      const failure = await planError(source.read(signal()));
      expect(failure).toMatchObject({ code: 'plan_usage_paused', retryable: false });
      expect(failure.message).toContain("Usage limit reached — Review your plan or this app's limit in ChatGPT settings.");
      expect(source.status().paused).toEqual({});
    }
    expect(h.fetchUrls.length).toBe(urlsBefore);
  });

  it('resume() ends the pause', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    await source.pause({});
    await source.resume();
    expect((await source.read(signal())).bearer).toBe(signIn.tokens.access_token);
    expect(source.status().paused).toBeUndefined();
  });

  it('a Retry-After pause ends when its time passes on the clock, and not before', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    const until = h.clock.now() + 90_000;
    await source.pause({ untilMs: until });
    h.clock.set(until - 1);
    expect((await planError(source.read(signal()))).code).toBe('plan_usage_paused');
    h.clock.set(until);
    expect((await source.read(signal())).bearer).toBe(signIn.tokens.access_token);
  });

  it('a pause belongs to its account only', async () => {
    const h = await harness();
    const { home } = await twoAccounts(h);
    await h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).pause({});
    expect((await h.sessions.authSource({ profile: PROFILE_ID, account: 'home' }).read(signal())).bearer).toBe(home.tokens.access_token);
  });
});

describe('pause and rejected act on the account whose bearer the read served (I-C8)', () => {
  it('pause after the active pointer moved pauses the served account, not the one the pointer names now', async () => {
    const h = await harness();
    const { work, home } = await twoAccounts(h);
    const unpinned = h.sessions.authSource({ profile: PROFILE_ID });
    expect((await unpinned.read(signal())).bearer).toBe(home.tokens.access_token);
    await pointTo(h, 'work');
    await unpinned.pause({});
    expect((await planError(h.sessions.authSource({ profile: PROFILE_ID, account: 'home' }).read(signal()))).code).toBe('plan_usage_paused');
    expect((await h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).read(signal())).bearer).toBe(work.tokens.access_token);
  });

  it('rejected after the active pointer moved refreshes the served account and leaves the other untouched', async () => {
    const h = await harness();
    const { home } = await twoAccounts(h);
    const unpinned = h.sessions.authSource({ profile: PROFILE_ID });
    const served = await unpinned.read(signal());
    expect(served.bearer).toBe(home.tokens.access_token);
    await pointTo(h, 'work');
    const workBefore = await readRecord(h, 'work');
    expect(await unpinned.rejected(served.generation, signal())).toBe('renewed');
    expect(h.auth.calls.tokenRefreshToken).toBe(1);
    expect(h.auth.records.find((record) => record.form['grant_type'] === 'refresh_token')?.form['refresh_token']).toBe(home.tokens.refresh_token);
    expect(await readRecord(h, 'work')).toEqual(workBefore);
    expect((await readRecord(h, 'home'))?.['generation']).toBe(served.generation + 1);
  });
});

describe('health of a plan target: one name per condition, the profile sentence, and the fix with known values filled in', () => {
  it('is ok while the account is active', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    expect(h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).health()).toMatchObject({ ok: true });
  });

  it('is sign_in_required with both sign-in entry points, profile and label filled in, when the account is absent', async () => {
    const h = await harness();
    const health = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).health();
    expect(health).toMatchObject({ ok: false, reason: 'sign_in_required' });
    expect(String(health.remediation)).toContain('/login');
    expect(String(health.remediation)).toContain('momonga auth login chatgpt --account work');
    expect(String(health.remediation)).not.toMatch(/<profile>|<label>/);
  });

  it.each(['needs_sign_in', 'registered'])('is sign_in_required in state %s', async (state) => {
    const h = await harness();
    await signedIn(h, 'work');
    await editRecord(h, 'work', (record) => ({ ...record, state }));
    await h.reopen({ accounts: [{ profile: PROFILE_ID, account: 'work' }] });
    const health = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).health();
    expect(health).toMatchObject({ ok: false, reason: 'sign_in_required' });
    expect(String(health.remediation)).toContain('momonga auth login chatgpt --account work');
  });

  it('plan_disabled is plan_use_not_enabled with the profile sentence and a sign-in with consent as the fix', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    await editRecord(h, 'work', (record) => ({ ...record, state: 'plan_disabled' }));
    await h.reopen({ accounts: [{ profile: PROFILE_ID, account: 'work' }] });
    const health = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).health();
    expect(health).toMatchObject({ ok: false, reason: 'plan_use_not_enabled', detail: "ChatGPT plan use isn't enabled" });
    expect(String(health.remediation)).toContain('/login');
    expect(String(health.remediation)).toContain('momonga auth login chatgpt --account work --reconsent');
  });

  it('a paused account is plan_usage_paused with the usage-limit sentence and resume as the fix', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    await source.pause({});
    const health = source.health();
    expect(health).toMatchObject({
      ok: false,
      reason: 'plan_usage_paused',
      detail: "Usage limit reached — Review your plan or this app's limit in ChatGPT settings.",
    });
    expect(String(health.remediation)).toContain('momonga auth resume work');
    expect(String(health.remediation)).not.toContain('momonga auth login');
  });
});
