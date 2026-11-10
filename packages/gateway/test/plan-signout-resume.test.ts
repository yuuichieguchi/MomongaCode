import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONDITION_WAIT, PROFILE_ID, errno, failingWrites, readRecord, signedIn, startHarness, writeSigningOut } from './plan-support.ts';
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
