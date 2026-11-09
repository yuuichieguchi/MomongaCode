import { describe, expect, it } from 'vitest';
import { SKIPPABLE_CODES, statusFor } from '../src/core/errors.ts';

describe('the plan request codes stop the request with their own status (P3, D6)', () => {
  it('answers sign_in_required with 401, plan_use_not_enabled with 403 and plan_usage_paused with 429 whatever the type', () => {
    expect(statusFor('invalid_request', 'sign_in_required')).toBe(401);
    expect(statusFor('invalid_request', 'plan_use_not_enabled')).toBe(403);
    expect(statusFor('invalid_request', 'plan_usage_paused')).toBe(429);
    expect(statusFor('server_error', 'plan_usage_paused')).toBe(429);
  });

  it('lists none of them as skippable', () => {
    expect(statusFor('server_error', 'sign_in_required')).toBe(401);
    for (const code of ['sign_in_required', 'plan_usage_paused', 'plan_use_not_enabled', 'plan_store_unreadable', 'plan_store_unwritable']) {
      expect(SKIPPABLE_CODES.has(code)).toBe(false);
    }
  });
});
