import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  INVALID_GRANT_REASON,
  PLAN_ACCOUNT_STATES,
  PLAN_DISABLED_STATE,
  PLAN_HEALTH_REASONS,
  PLAN_REVOCATIONS,
  PLAN_REVOCATION_ANSWERS,
  PLAN_REVOCATION_CONFIRMED,
  PLAN_REVOCATION_NONE,
  PLAN_REVOCATION_UNCONFIRMED,
  PLAN_SIGN_IN_FAILURE,
  PLAN_SIGN_IN_FAILURES,
  PLAN_SIGN_IN_FAILURE_RULES,
  PLAN_SIGN_IN_OUTCOMES,
  PLAN_STORE_STATES,
  PLAN_STORE_UNREADABLE_STATE,
  PLAN_STORE_UNWRITABLE_STATE,
  RETRY_OUTCOME,
  SERVICE_UNAVAILABLE_STATUS,
  SIGNED_IN_OUTCOME,
  TARGET_HEALTH_REASONS,
  TARGET_PROBE_FAILED,
  TARGET_PROBING,
  isTargetProbing,
} from '../src/index.ts';
import type { PlanRevocation, PlanRevocationAnswer, PlanSignInCompleteResponse, PlanSignInFailure } from '../src/index.ts';

describe('the words of the plan API are protocol constants (A4)', () => {
  it('the store states are named once and every list that holds them is built from the names', () => {
    expect([PLAN_STORE_UNREADABLE_STATE, PLAN_STORE_UNWRITABLE_STATE]).toEqual(['store_unreadable', 'store_unwritable']);
    expect(PLAN_STORE_STATES).toEqual([PLAN_STORE_UNREADABLE_STATE, PLAN_STORE_UNWRITABLE_STATE]);
    for (const list of [PLAN_ACCOUNT_STATES, PLAN_HEALTH_REASONS, TARGET_HEALTH_REASONS] as ReadonlyArray<readonly string[]>) expect(list).toEqual(expect.arrayContaining([...PLAN_STORE_STATES]));
  });

  it('the account states keep their order', () => {
    expect(PLAN_ACCOUNT_STATES).toEqual(['active', 'plan_disabled', 'needs_sign_in', 'signing_out', 'registered', 'store_unreadable', 'store_unwritable']);
    expect(PLAN_DISABLED_STATE).toBe('plan_disabled');
  });

  it('every sign-in failure code has one name, and the rules are keyed by the names', () => {
    expect(Object.values(PLAN_SIGN_IN_FAILURE)).toEqual([
      'attempt_not_found',
      'attempt_expired',
      'state_mismatch',
      'access_denied',
      'authorization_failed',
      'registration_incomplete',
      'client_mismatch',
      'registration_superseded',
      'exchange_rejected',
      'exchange_unavailable',
      'token_response_invalid',
      'id_token_invalid',
      'jwks_unavailable',
      'identity_mismatch',
      'identity_not_exchanged',
      'identity_late',
    ]);
    expect(Object.keys(PLAN_SIGN_IN_FAILURE_RULES)).toEqual(Object.values(PLAN_SIGN_IN_FAILURE));
    expect(PLAN_SIGN_IN_FAILURES).toEqual(Object.values(PLAN_SIGN_IN_FAILURE));
    expectTypeOf<(typeof PLAN_SIGN_IN_FAILURE)[keyof typeof PLAN_SIGN_IN_FAILURE]>().toEqualTypeOf<PlanSignInFailure>();
  });

  it('the sign-in outcomes and the retry reason are named, and the complete answer is typed by them', () => {
    expect(PLAN_SIGN_IN_OUTCOMES).toEqual(['signed_in', 'plan_disabled', 'retry', 'identity_unconfirmed']);
    expect([SIGNED_IN_OUTCOME, RETRY_OUTCOME, INVALID_GRANT_REASON]).toEqual(['signed_in', 'retry', 'invalid_grant']);
    expectTypeOf<PlanSignInCompleteResponse['outcome']>().toEqualTypeOf<(typeof PLAN_SIGN_IN_OUTCOMES)[number]>();
    expectTypeOf<Extract<PlanSignInCompleteResponse, { outcome: typeof RETRY_OUTCOME }>['reason']>().toEqualTypeOf<typeof INVALID_GRANT_REASON>();
  });

  it('the revocation values have one list: the two answers of the provider and none', () => {
    expect(PLAN_REVOCATION_ANSWERS).toEqual([PLAN_REVOCATION_CONFIRMED, PLAN_REVOCATION_UNCONFIRMED]);
    expect(PLAN_REVOCATIONS).toEqual(['confirmed', 'unconfirmed', 'none']);
    expect(PLAN_REVOCATIONS).toEqual([...PLAN_REVOCATION_ANSWERS, PLAN_REVOCATION_NONE]);
    expectTypeOf<PlanRevocationAnswer>().toEqualTypeOf<Exclude<PlanRevocation, typeof PLAN_REVOCATION_NONE>>();
  });
});

describe('isTargetProbing is the one predicate of the measuring answer (A3)', () => {
  it('holds for status 503 with the code target_probing and for nothing else', () => {
    expect(SERVICE_UNAVAILABLE_STATUS).toBe(503);
    expect(isTargetProbing({ status: SERVICE_UNAVAILABLE_STATUS, code: TARGET_PROBING })).toBe(true);
    expect(isTargetProbing({ status: 500, code: TARGET_PROBING })).toBe(false);
    expect(isTargetProbing({ status: SERVICE_UNAVAILABLE_STATUS, code: TARGET_PROBE_FAILED })).toBe(false);
    expect(isTargetProbing({ status: SERVICE_UNAVAILABLE_STATUS, code: null })).toBe(false);
  });
});
