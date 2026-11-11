import { afterEach, describe, expect, it } from 'vitest';
import { PLAN_SESSION_DEFAULTS } from '../src/defaults.ts';
import { NEVER_ENDED, PAUSE_CODE, PROFILE_ID, START_MS, failingWrites, planError, signedIn, startHarness, toRefreshWindow } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const work = { profile: PROFILE_ID, account: 'work' };

describe('close() reports only a failure nobody received (N-G4, G4-15)', () => {
  it('a refresh that fails after close() began, with its caller still waiting, is that caller\'s failure: close() resolves', async () => {
    const h = await startHarness();
    closers.push(() => h.close());
    await signedIn(h, 'work');
    toRefreshWindow(h, START_MS);
    const outbound = h.holdNextOutbound();
    const reading = planError(h.sessions.authSource(work).read(NEVER_ENDED));
    await outbound.reached;
    const closed = h.sessions.close();
    outbound.fail(new Error('the outbound port broke'));
    expect((await reading).message).toBe('the outbound port broke');
    await expect(closed).resolves.toBeUndefined();
  });

  it('a background failure nobody received is reported by close() once', async () => {
    const transient = Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    const h = await startHarness({
      wrapSleep: (inner) => (ms, signal) => (ms === PLAN_SESSION_DEFAULTS.persistRetryMs ? Promise.reject(new Error('the timer port broke')) : inner(ms, signal)),
    });
    closers.push(() => h.close());
    await signedIn(h, 'work');
    let failing = true;
    await h.reopen({ accounts: [work], store: failingWrites(h.store, () => (failing ? transient : undefined)) });
    await h.sessions.authSource(work).pause({ untilMs: START_MS + 60_000, code: PAUSE_CODE }, NEVER_ENDED);
    failing = false;
    const failure = await h.sessions.close().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual(['the timer port broke']);
    await expect(h.sessions.close()).resolves.toBeUndefined();
  });
});
