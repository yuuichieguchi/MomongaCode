import { afterEach, describe, expect, it } from 'vitest';
import { PROFILE_ID, editRecord, planError, signedIn, startHarness } from './plan-support.ts';
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

const REMEDIATION_ENTRY_POINTS = ['/login', 'momonga auth login'];

describe('the account pause of M7', () => {
  it('pauses every target on the account: reads fail at once with plan_usage_paused and the usage-limit sentence, and nothing is sent', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const pinnedSource = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    const activeSource = h.sessions.authSource({ profile: PROFILE_ID });
    await h.sessions.pause({ profile: PROFILE_ID, account: 'work' }, {});
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
    await h.sessions.pause({ profile: PROFILE_ID, account: 'work' }, {});
    await source.resume();
    expect((await source.read(signal())).bearer).toBe(signIn.tokens.access_token);
    expect(source.status().paused).toBeUndefined();
  });

  it('a Retry-After pause ends when its time passes on the clock, and not before', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    const until = h.clock.now() + 90_000;
    await h.sessions.pause({ profile: PROFILE_ID, account: 'work' }, { untilMs: until });
    h.clock.set(until - 1);
    expect((await planError(source.read(signal()))).code).toBe('plan_usage_paused');
    h.clock.set(until);
    expect((await source.read(signal())).bearer).toBe(signIn.tokens.access_token);
  });

  it('a pause belongs to its account only', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.auth.identity = { sub: 'sub-second-user', email: 'second@example.com' };
    const home = await signedIn(h, 'home');
    await h.sessions.pause({ profile: PROFILE_ID, account: 'work' }, {});
    expect((await h.sessions.authSource({ profile: PROFILE_ID, account: 'home' }).read(signal())).bearer).toBe(home.tokens.access_token);
  });
});

describe('health of a plan target', () => {
  it('is ok while the account is active', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    expect(h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).health()).toMatchObject({ ok: true });
  });

  it('is sign_in_required with both entry points when the account is absent', async () => {
    const h = await harness();
    const health = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).health();
    expect(health).toMatchObject({ ok: false, reason: 'sign_in_required' });
    for (const entry of REMEDIATION_ENTRY_POINTS) expect(String(health.remediation)).toContain(entry);
  });

  it.each(['needs_sign_in', 'registered'])('is sign_in_required in state %s', async (state) => {
    const h = await harness();
    await signedIn(h, 'work');
    await editRecord(h, 'work', (record) => ({ ...record, state }));
    await h.reopen({ accounts: [{ profile: PROFILE_ID, account: 'work' }] });
    expect(h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).health()).toMatchObject({ ok: false, reason: 'sign_in_required' });
  });

  it('plan_disabled and paused are not ok and name both entry points', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const source = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });
    await h.sessions.pause({ profile: PROFILE_ID, account: 'work' }, {});
    const paused = source.health();
    expect(paused.ok).toBe(false);
    for (const entry of REMEDIATION_ENTRY_POINTS) expect(String(paused.remediation)).toContain(entry);
    await editRecord(h, 'work', (record) => ({ ...record, state: 'plan_disabled' }));
    await h.reopen({ accounts: [{ profile: PROFILE_ID, account: 'work' }] });
    const disabled = h.sessions.authSource({ profile: PROFILE_ID, account: 'work' }).health();
    expect(disabled.ok).toBe(false);
    for (const entry of REMEDIATION_ENTRY_POINTS) expect(String(disabled.remediation)).toContain(entry);
  });
});
