import { afterEach, describe, expect, it } from 'vitest';
import { LockWaitTimeoutError } from '@momonga/foundation';
import { PLAN_SESSION_DEFAULTS } from '../src/defaults.ts';
import { NEVER_ENDED, PAUSE_CODE, PROFILE_ID, START_MS, planError, rawRecord, readRecord, refusingLocks, signInAtFake, signedIn, startHarness, toRefreshWindow } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const work = { profile: PROFILE_ID, account: 'work' };

const lockTimeout = (): Error => new LockWaitTimeoutError('/state/plan-sessions/record.lock', 10_000, '4242');

const withRefusedLock = async (): Promise<{ h: Harness; refuse(on: boolean): void }> => {
  const h = await startHarness();
  harnesses.push(h);
  await signedIn(h, 'work');
  let refusing = false;
  await h.reopen({ accounts: [work], store: refusingLocks(h.store, () => (refusing ? lockTimeout() : undefined)) });
  return {
    h,
    refuse: (on) => {
      refusing = on;
    },
  };
};

describe('a record lock that cannot be taken in time is a transient failed first write (A5, F6, K1-9, K1-10)', () => {
  it('a pause is adopted in memory, stays dirty for the persist retry and the account is not store_unwritable', async () => {
    const { h, refuse } = await withRefusedLock();
    const source = h.sessions.authSource(work);
    refuse(true);
    const retry = h.holdNextBackoff();
    await source.pause({ untilMs: START_MS + 60_000, code: PAUSE_CODE }, NEVER_ENDED);
    await retry.reached;
    expect(source.status()).toMatchObject({ state: 'active', paused: { until: START_MS + 60_000 } });
    expect(h.sleeps).toEqual([PLAN_SESSION_DEFAULTS.persistRetryMs]);
    expect((await readRecord(h, 'work'))?.['paused']).toBeUndefined();
    expect(h.events.filter((event) => event.name === 'plan.pause').map((event) => event.data['saved'])).toEqual([false]);
    refuse(false);
    retry.release();
    await expect.poll(async () => (await readRecord(h, 'work'))?.['paused']).toEqual({ until: START_MS + 60_000 });
  });

  it('a refresh serves the held token while it is valid and the account is not store_unwritable', async () => {
    const { h, refuse } = await withRefusedLock();
    const source = h.sessions.authSource(work);
    const before = await source.read(NEVER_ENDED);
    toRefreshWindow(h, START_MS);
    refuse(true);
    h.holdNextBackoff();
    expect(await source.read(NEVER_ENDED)).toEqual(before);
    expect(source.status().state).toBe('active');
    expect(h.auth.calls.tokenRefreshToken).toBe(0);
  });

  it('a lock timeout during sign-in is a retryable failure that writes nothing', async () => {
    const { h, refuse } = await withRefusedLock();
    const bytes = await rawRecord(h, 'work');
    const again = await signInAtFake(h);
    refuse(true);
    const failure = await planError(
      h.sessions.install({ profile: PROFILE_ID, account: 'work', clientId: again.clientId, hostId: again.hostId, subject: again.subject, email: again.email, idToken: again.idToken, tokens: again.tokens }, NEVER_ENDED),
    );
    expect(failure).toMatchObject({ code: 'plan_store_unwritable', retryable: true });
    expect(failure.message).toContain('timed out after 10000ms waiting for lock');
    expect(await rawRecord(h, 'work')).toBe(bytes);
  });
});
