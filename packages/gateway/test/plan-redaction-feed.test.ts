import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_LIFETIME_MS, MARGIN_MS, PROFILE_ID, SECOND, SKEW_MS, START_MS, PAUSE_CODE, planError, readRecord, recordKey, signedIn, startHarness, toRefreshWindow } from './plan-support.ts';
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

const signal = (): AbortSignal => new AbortController().signal;

const source = (h: Harness) => h.sessions.authSource({ profile: PROFILE_ID, account: 'work' });

const tokensOf = async (h: Harness): Promise<string[]> => {
  const record = await readRecord(h, 'work');
  return ['access_token', 'refresh_token', 'id_token'].map((field) => record?.[field]).filter((value): value is string => typeof value === 'string');
};

const accessOf = async (h: Harness): Promise<string> => String((await readRecord(h, 'work'))?.['access_token']);

const fedOf = (h: Harness): string[] => {
  const fed = h.fed.get(KEY);
  if (fed === undefined) throw new Error(`nothing was fed for ${KEY}`);
  return fed;
};

const sorted = (values: readonly string[]): string[] => [...values].sort();

const forcedRefresh = async (h: Harness): Promise<void> => {
  const { generation } = await source(h).read(signal());
  expect(await source(h).rejected(generation, signal())).toBe('renewed');
};

describe('the plan feeder sets one key per account: current, previous and live older access tokens (P-G3)', () => {
  it('one refresh feeds the key once, with the three current tokens and the three of the record before (6 values)', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const installed = await tokensOf(h);
    const sets = vi.spyOn(h.fed, 'set');
    toRefreshWindow(h, START_MS);
    await source(h).read(signal());
    const refreshed = await tokensOf(h);
    expect(sets.mock.calls.filter(([key]) => key === KEY)).toHaveLength(1);
    expect(sorted(fedOf(h))).toEqual(sorted([...refreshed, ...installed]));
    expect(fedOf(h)).toHaveLength(6);
  });

  it('three lazy refreshes: the access token replaced longest ago is held in older while its expiresAt is in the future on h.clock and is gone at the first replacement after it passed', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const first = await accessOf(h);
    h.auth.scriptToken('refresh_token', [{ kind: 'expires_in', seconds: 121 }, { kind: 'expires_in', seconds: 121 }, { kind: 'expires_in', seconds: 121 }]);
    const firstRefreshAt = START_MS + ACCESS_LIFETIME_MS - MARGIN_MS;
    h.clock.set(firstRefreshAt);
    await source(h).read(signal());
    const second = await accessOf(h);
    h.clock.set(firstRefreshAt + 61 * SECOND);
    await source(h).read(signal());
    expect(h.auth.calls.tokenRefreshToken).toBe(2);
    expect(fedOf(h)).toContain(first);
    expect(fedOf(h)).toHaveLength(7);
    h.clock.set(firstRefreshAt + 122 * SECOND);
    await source(h).read(signal());
    expect(h.auth.calls.tokenRefreshToken).toBe(3);
    expect(fedOf(h)).not.toContain(first);
    expect(fedOf(h)).not.toContain(second);
    expect(fedOf(h)).toHaveLength(6);
  });

  it('an unchanged record adopted again (intent write, pause, resume) feeds nothing', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const sets = vi.spyOn(h.fed, 'set');
    toRefreshWindow(h, START_MS);
    await source(h).read(signal());
    expect(sets).toHaveBeenCalledTimes(1);
    await source(h).pause({ code: PAUSE_CODE }, new AbortController().signal);
    await source(h).resume(new AbortController().signal);
    expect(sets).toHaveBeenCalledTimes(1);
  });

  it('sign-out and a terminal refresh feed nothing and remove nothing', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const fedAtInstall = [...fedOf(h)];
    const sets = vi.spyOn(h.fed, 'set');
    h.auth.scriptToken('refresh_token', [{ kind: 'error', code: 'invalid_grant' }]);
    toRefreshWindow(h, START_MS);
    expect((await planError(source(h).read(signal()))).code).toBe('sign_in_required');
    expect(sets).not.toHaveBeenCalled();
    expect(fedOf(h)).toEqual(fedAtInstall);
    const other = await harness();
    await signedIn(other, 'work');
    const fedBeforeSignOut = [...fedOf(other)];
    const otherSets = vi.spyOn(other.fed, 'set');
    await other.sessions.signOut({ profile: PROFILE_ID, account: 'work' }, signal());
    expect(otherSets).not.toHaveBeenCalled();
    expect(fedOf(other)).toEqual(fedBeforeSignOut);
  });

  it('load feeds the record\'s three tokens', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const installed = await tokensOf(h);
    h.fed.clear();
    await h.reopen({ accounts: [{ profile: PROFILE_ID, account: 'work' }] });
    await h.sessions.load({ profile: PROFILE_ID, account: 'work' }, new AbortController().signal);
    expect(sorted(fedOf(h))).toEqual(sorted(installed));
  });

  it('a forced refresh keeps the refused access token in previous; the next refresh drops it (two records old) while a lazily replaced one stays until its expiresAt', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    const refused = await accessOf(h);
    h.clock.advance(SKEW_MS);
    await forcedRefresh(h);
    expect(fedOf(h)).toContain(refused);
    const secondIssuedAt = h.clock.now();
    const lazilyReplaced = await accessOf(h);
    h.clock.set(secondIssuedAt + ACCESS_LIFETIME_MS - MARGIN_MS);
    await source(h).read(signal());
    expect(fedOf(h)).not.toContain(refused);
    h.clock.advance(SKEW_MS);
    await forcedRefresh(h);
    expect(fedOf(h)).toContain(lazilyReplaced);
    h.clock.set(secondIssuedAt + ACCESS_LIFETIME_MS);
    await forcedRefresh(h);
    expect(fedOf(h)).not.toContain(lazilyReplaced);
    expect(h.auth.calls.tokenRefreshToken).toBe(4);
  });

  it('the set never holds more than 9 values over 20 lazy refreshes with expires_in 3600 and over 20 reads with expires_in 100', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    for (let refresh = 0; refresh < 20; refresh += 1) {
      const expiresAt = Number((await readRecord(h, 'work'))?.['expiresAt']);
      h.clock.set(expiresAt - MARGIN_MS);
      await source(h).read(signal());
      expect(fedOf(h).length).toBeLessThanOrEqual(9);
    }
    expect(h.auth.calls.tokenRefreshToken).toBe(20);
    const short = await harness();
    short.auth.scriptToken('authorization_code', [{ kind: 'expires_in', seconds: 100 }]);
    short.auth.scriptToken('refresh_token', Array.from({ length: 20 }, () => ({ kind: 'expires_in' as const, seconds: 100 })));
    await signedIn(short, 'work');
    for (let read = 1; read <= 20; read += 1) {
      short.clock.set(START_MS + read * 30 * SECOND);
      await source(short).read(signal()).catch(() => undefined);
      expect(fedOf(short).length).toBeLessThanOrEqual(9);
    }
  });
});
