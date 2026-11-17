import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationLimitError, operationLimit } from '@momonga/foundation';
import { PLAN_CREDENTIAL_UNAVAILABLE_CODE } from '@momonga/protocol';
import { PlanCredentialError } from '../src/plan/auth-source.ts';
import { CONDITION_WAIT, PROFILE_ID, signedIn, startHarness } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const work = { profile: PROFILE_ID, account: 'work' };
const WAITER_LIMIT_MS = 5_000;

describe('a waiter of a shared refresh that leaves by its own limit', () => {
  it('ends with the credential-unavailable failure, the limit as its cause', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    h.clock.advance(60_000);
    const source = h.sessions.authSource(work);
    const { generation } = await source.read(new AbortController().signal);
    const gate = h.holdNextRefresh();
    const bound = operationLimit(new AbortController().signal, WAITER_LIMIT_MS, 'the waiter limit', h.timing);
    const waiting = source.rejected(generation, bound.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(h.fetchUrls.filter((url) => url === h.auth.tokenUrl)).toHaveLength(1), CONDITION_WAIT);
    h.fireLimit(WAITER_LIMIT_MS);
    const error = await waiting;
    gate.release();
    bound.dispose();
    expect(error).toBeInstanceOf(PlanCredentialError);
    expect(error).toMatchObject({ code: PLAN_CREDENTIAL_UNAVAILABLE_CODE, cause: expect.any(OperationLimitError) });
  });
});
