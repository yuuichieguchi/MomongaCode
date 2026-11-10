import { afterEach, describe, expect, it } from 'vitest';
import { PROFILE_ID, START_MS, planError, readRecord, signedIn, startHarness, toRefreshWindow } from './plan-support.ts';
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

const work = { profile: PROFILE_ID, account: 'work' };

const readWork = (h: Harness) => h.sessions.authSource(work).read(new AbortController().signal);

const DROPPED_REFRESH = [{ kind: 'drop' as const }, { kind: 'drop' as const }, { kind: 'drop' as const }];

const terminalEvents = (h: Harness) => h.events.filter((event) => event.name === 'plan.refresh' && event.data['outcome'] === 'terminal').map((event) => event.data);

describe('interrupted is read from the record found when the refresh begins (P-S7)', () => {
  it('refresh 1 times out on every send (transient), refresh 2 gets refresh_token_reused: the event and the record say interrupted true, cause refresh_token_reused', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.auth.scriptToken('refresh_token', [...DROPPED_REFRESH, { kind: 'error', code: 'refresh_token_reused' }]);
    toRefreshWindow(h, START_MS);
    await readWork(h);
    expect(h.auth.calls.tokenRefreshToken).toBe(3);
    expect((await planError(readWork(h))).code).toBe('sign_in_required');
    expect(terminalEvents(h)).toEqual([expect.objectContaining({ code: 'refresh_token_reused', interrupted: true })]);
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'needs_sign_in', cause: 'refresh_token_reused', interrupted: true });
  });

  it('the same history across a restart gives the same event', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.auth.scriptToken('refresh_token', [...DROPPED_REFRESH, { kind: 'error', code: 'refresh_token_reused' }]);
    toRefreshWindow(h, START_MS);
    await readWork(h);
    await h.reopen({ accounts: [work] });
    expect((await planError(readWork(h))).code).toBe('sign_in_required');
    expect(terminalEvents(h)).toEqual([expect.objectContaining({ code: 'refresh_token_reused', interrupted: true })]);
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'needs_sign_in', cause: 'refresh_token_reused', interrupted: true });
  });

  it('a refresh with no earlier intent whose first send is answered terminal says interrupted false', async () => {
    const h = await harness();
    await signedIn(h, 'work');
    h.auth.scriptToken('refresh_token', [{ kind: 'error', code: 'refresh_token_reused' }]);
    toRefreshWindow(h, START_MS);
    expect((await planError(readWork(h))).code).toBe('sign_in_required');
    expect(terminalEvents(h)).toEqual([expect.objectContaining({ code: 'refresh_token_reused', interrupted: false })]);
    const record = await readRecord(h, 'work');
    expect(record?.['state']).toBe('needs_sign_in');
    expect(record?.['interrupted']).not.toBe(true);
  });

  it('a 200 without a replacement after a transient refresh keeps pendingRefresh and the next terminal says interrupted true', async () => {
    const h = await harness();
    const signIn = await signedIn(h, 'work');
    h.auth.scriptToken('refresh_token', [...DROPPED_REFRESH, { kind: 'no_replacement_refresh_token' }, { kind: 'error', code: 'refresh_token_reused' }]);
    toRefreshWindow(h, START_MS);
    await readWork(h);
    await readWork(h);
    expect(h.auth.calls.tokenRefreshToken).toBe(4);
    const kept = await readRecord(h, 'work');
    expect(kept).toMatchObject({ state: 'active', refresh_token: signIn.tokens.refresh_token });
    expect(kept?.['pendingRefresh']).toBeDefined();
    toRefreshWindow(h, h.clock.now());
    expect((await planError(readWork(h))).code).toBe('sign_in_required');
    expect(await readRecord(h, 'work')).toMatchObject({ state: 'needs_sign_in', cause: 'refresh_token_reused', interrupted: true });
  });
});
