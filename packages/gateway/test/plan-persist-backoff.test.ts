import { afterEach, describe, expect, it } from 'vitest';
import type { ListableCredentialStore } from '@momonga/foundation';
import { PLAN_SESSION_DEFAULTS } from '../src/defaults.ts';
import { NEVER_ENDED, PAUSE_CODE, PROFILE_ID, START_MS, errno, failingWrites, readRecord, signedIn, startHarness } from './plan-support.ts';
import type { Harness, ReachedGate } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const work = { profile: PROFILE_ID, account: 'work' };

const BASE_MS = PLAN_SESSION_DEFAULTS.persistRetryMs;
const CAP_MS = PLAN_SESSION_DEFAULTS.persistRetryMaxMs;

const countingLocks = (inner: ListableCredentialStore): { store: ListableCredentialStore; maxActive(): number; calls(): number } => {
  let active = 0;
  let most = 0;
  let calls = 0;
  return {
    maxActive: () => most,
    calls: () => calls,
    store: {
      ...inner,
      withKey: async (key, action, signal) => {
        calls += 1;
        active += 1;
        most = Math.max(most, active);
        try {
          return await inner.withKey(key, action, signal);
        } finally {
          active -= 1;
        }
      },
    },
  };
};

describe('the persist retry backs off while the store stays locked (P-107, DECISION-2)', () => {
  it('the wait before each attempt doubles from persistRetryMs up to the cap, attempts never overlap, and the record is written at the first attempt after the store unlocks', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    let locked = true;
    const counting = countingLocks(failingWrites(h.store, () => (locked ? errno('EBUSY') : undefined)));
    await h.reopen({ accounts: [work], store: counting.store });
    let gate: ReachedGate = h.holdNextBackoff();
    await h.sessions.authSource(work).pause({ untilMs: START_MS + 60_000, code: PAUSE_CODE }, NEVER_ENDED);
    const expected = [BASE_MS, 2 * BASE_MS, 4 * BASE_MS, 8 * BASE_MS, 16 * BASE_MS, CAP_MS, CAP_MS];
    expect(32 * BASE_MS).toBeGreaterThan(CAP_MS);
    for (let attempt = 0; attempt < expected.length; attempt += 1) {
      await gate.reached;
      expect(h.sleeps).toEqual(expected.slice(0, attempt + 1));
      const callsBefore = counting.calls();
      const next = h.holdNextBackoff();
      if (attempt === expected.length - 1) locked = false;
      gate.release();
      if (attempt < expected.length - 1) {
        await next.reached;
        expect(counting.calls()).toBe(callsBefore + 1);
      }
      gate = next;
    }
    await expect.poll(async () => (await readRecord(h, 'work'))?.['paused']).toEqual({ until: START_MS + 60_000 });
    expect(h.sleeps).toEqual(expected);
    expect(counting.maxActive()).toBe(1);
    expect(h.sessions.authSource(work).status().state).toBe('active');
  });

  it('a later failure starts again at persistRetryMs', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    let locked = true;
    await h.reopen({ accounts: [work], store: failingWrites(h.store, () => (locked ? errno('EBUSY') : undefined)) });
    const source = h.sessions.authSource(work);
    const first = h.holdNextBackoff();
    await source.pause({ untilMs: START_MS + 60_000, code: PAUSE_CODE }, NEVER_ENDED);
    await first.reached;
    const second = h.holdNextBackoff();
    first.release();
    await second.reached;
    locked = false;
    second.release();
    await expect.poll(async () => (await readRecord(h, 'work'))?.['paused']).toEqual({ until: START_MS + 60_000 });
    locked = true;
    const again = h.holdNextBackoff();
    await source.resume(NEVER_ENDED);
    await again.reached;
    expect(h.sleeps).toEqual([BASE_MS, 2 * BASE_MS, BASE_MS]);
  });
});
