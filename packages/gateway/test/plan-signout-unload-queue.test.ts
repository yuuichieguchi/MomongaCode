import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONDITION_WAIT, PAUSE_CODE, PROFILE_ID, errno, holdingOneWrite, planError, readRecord, signedIn, startHarness } from './plan-support.ts';
import type { Harness, HeldWrite, RecordedPlanEvent } from './plan-support.ts';

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

const isCleared = (value: string): boolean => (JSON.parse(value) as Record<string, unknown>)['state'] === 'registered';

const named = (h: Harness, name: string): Array<RecordedPlanEvent['data']> => h.events.filter((event) => event.name === name).map((event) => event.data);

type FailingFlight = { held: HeldWrite; first: Promise<{ code: string; retryable: boolean; message: string }> };

const signOutParkedInItsClearedWrite = async (h: Harness): Promise<FailingFlight> => {
  await signedIn(h, 'work');
  const held = holdingOneWrite(h.store, isCleared);
  await h.reopen({ accounts: [work], store: held.store });
  const first = planError(h.sessions.signOut(work, signal()));
  await held.reached;
  expect(held.lockRequests()).toBe(1);
  expect((await readRecord(h, 'work'))?.['state']).toBe('signing_out');
  return { held, first };
};

describe('a request that waited for the record lock behind a sign-out that ended unloaded sees what a fresh load gives (K7)', () => {
  it('a second sign-out queued behind a sign-out whose cleared-record write fails joins the resumed sign-out and gets its report', { timeout: 60_000 }, async () => {
    const h = await harness();
    const { held, first } = await signOutParkedInItsClearedWrite(h);
    const second = h.sessions.signOut(work, signal()).then(
      (report) => ({ report }),
      (error: unknown) => ({ failure: String((error as { code?: unknown }).code) }),
    );
    await vi.waitFor(() => expect(held.lockRequests()).toBe(2), CONDITION_WAIT);
    held.fail(errno('EACCES'));
    expect((await first).code).toBe('plan_store_unwritable');
    expect(await second).toEqual({ report: { revocation: 'confirmed', usageUrl: h.profile.usageUrl } });
    expect((await readRecord(h, 'work'))?.['state']).toBe('registered');
    expect(named(h, 'plan.sign_out')).toEqual([
      { profile: PROFILE_ID, account: 'work', resumed: false, end: 'failed', revocation: 'confirmed', code: 'plan_store_unwritable' },
      { profile: PROFILE_ID, account: 'work', resumed: true, end: 'cleared', revocation: 'confirmed' },
    ]);
  });

  it('a pause queued behind a sign-out whose cleared-record write fails is not lost', { timeout: 60_000 }, async () => {
    const h = await harness();
    const { held, first } = await signOutParkedInItsClearedWrite(h);
    const paused = h.sessions.authSource(work).pause({ code: PAUSE_CODE });
    await vi.waitFor(() => expect(held.lockRequests()).toBe(2), CONDITION_WAIT);
    held.fail(errno('EACCES'));
    expect((await first).code).toBe('plan_store_unwritable');
    await expect(paused).resolves.toBeUndefined();
    expect(named(h, 'plan.pause')).toEqual([{ profile: PROFILE_ID, account: 'work', code: PAUSE_CODE, saved: true }]);
  });
});
