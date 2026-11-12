import { afterEach, describe, expect, it } from 'vitest';
import { createFakeClock, textResponseEvents } from '@momonga/testkit';
import type { ClassifiedError, StreamEvent } from '@momonga/protocol';
import { applyCredentialEffect } from '../src/adapters/shared/auth.ts';
import { GatewayError } from '../src/core/errors.ts';
import { accountViewOf, planRouteError } from '../src/plan/api.ts';
import { PlanCredentialError } from '../src/plan/auth-source.ts';
import { MAX_DATE_MS } from '@momonga/foundation';
import { pauseEndOf } from '../src/plan/pause-end.ts';
import { collectTerminalResource } from '../src/server/response-body.ts';
import { fakeAuth } from './plan-auth-support.ts';
import { NEVER_ENDED, PAUSE_CODE, PROFILE_ID, START_MS, editRecord, readRecord, signedIn, startHarness } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const work = { profile: PROFILE_ID, account: 'work' };

const BEYOND_DATE_MS = 9_000_000_000_000 * 1000;

describe('the end of a pause is a time a Date can hold, or it is not set (N-PAUSE-1, G6-7, G6-8)', () => {
  it('pauseEndOf gives now + retryAfterMs up to 8.64e15 ms and nothing beyond it', () => {
    expect(MAX_DATE_MS).toBe(8.64e15);
    expect(pauseEndOf(START_MS, 30_000)).toBe(START_MS + 30_000);
    expect(pauseEndOf(START_MS, MAX_DATE_MS - START_MS)).toBe(MAX_DATE_MS);
    expect(pauseEndOf(START_MS, MAX_DATE_MS - START_MS + 1)).toBeUndefined();
    expect(pauseEndOf(START_MS, BEYOND_DATE_MS)).toBeUndefined();
    expect(pauseEndOf(START_MS, Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(pauseEndOf(START_MS, Number.NaN)).toBeUndefined();
    expect(pauseEndOf(START_MS, undefined)).toBeUndefined();
  });

  it('Retry-After: 9000000000000 pauses the credential without an end', async () => {
    const auth = fakeAuth();
    const classified: ClassifiedError = { retryable: false, retryAfterMs: BEYOND_DATE_MS, credential: 'pause', error: { type: 'too_many_requests', code: PAUSE_CODE, message: 'limit', param: null } };
    await applyCredentialEffect(auth, classified, createFakeClock(START_MS), NEVER_ENDED);
    expect(auth.pauses).toEqual([{ code: PAUSE_CODE }]);
  });

  it('a pause asked with an end beyond the range is saved as paused {}, writes its event without until, is listed and resumes', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    const source = h.sessions.authSource(work);
    await source.pause({ untilMs: START_MS + BEYOND_DATE_MS, code: PAUSE_CODE }, NEVER_ENDED);
    expect((await readRecord(h, 'work'))?.['paused']).toEqual({});
    expect(h.events.filter((event) => event.name === 'plan.pause').map((event) => event.data)).toEqual([{ profile: PROFILE_ID, account: 'work', code: PAUSE_CODE, saved: true }]);
    const [known] = await h.sessions.known(NEVER_ENDED);
    if (known === undefined) throw new Error('the account is not listed');
    expect(accountViewOf(work, known.view, true, [], h.clock.now())).toMatchObject({ state: 'active', paused: {} });
    expect(await h.sessions.resume(work, NEVER_ENDED)).toBe(true);
    expect((await readRecord(h, 'work'))?.['paused']).toBeUndefined();
  });

  it.each([9e15, -9e15, 8.64e15 + 2])('a stored until of %s that no Date can hold is read as a pause without an end', async (until) => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    await editRecord(h, 'work', (record) => ({ ...record, paused: { until } }));
    await h.reopen({ accounts: [work] });
    const [known] = await h.sessions.known(NEVER_ENDED);
    if (known === undefined) throw new Error('the account is not listed');
    expect(accountViewOf(work, known.view, true, [], h.clock.now())).toMatchObject({ state: 'active', paused: {} });
    expect(h.sessions.authSource(work).status()).toMatchObject({ paused: {} });
  });
});

describe('every answer built from a plan credential failure with a retry-after carries it (P-003, N-ROUTE-1)', () => {
  it('a plan route answer carries retry-after in whole seconds', () => {
    const failure = planRouteError(new PlanCredentialError('plan_usage_paused', 'Usage limit reached', false, { retryAfterMs: 30_500 }));
    expect(failure).toBeInstanceOf(GatewayError);
    expect((failure as GatewayError).headers).toEqual({ 'retry-after': '31' });
    expect((planRouteError(new PlanCredentialError('plan_usage_paused', 'Usage limit reached', false)) as GatewayError).headers).toEqual({});
  });

  it('a failed stream collected into one answer keeps plan and retry-after', async () => {
    const [created] = textResponseEvents({ model: 'm', chunks: ['x'] });
    if (created === undefined || !('response' in created)) throw new Error('no response event to build on');
    const failed: StreamEvent = {
      type: 'response.failed',
      sequence_number: 1,
      response: { ...created.response, status: 'failed', error: { code: 'plan_usage_limit', type: 'too_many_requests', message: 'limit', retryAfterMs: 30_000, plan: work } },
    };
    const rest: AsyncIterator<StreamEvent> = { next: async () => ({ done: true, value: undefined }) };
    const failure = await collectTerminalResource(failed, rest).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GatewayError);
    expect(failure).toMatchObject({ status: 429, body: { code: 'plan_usage_limit', plan: work }, headers: { 'retry-after': '30' } });
  });
});
