import { describe, expect, it } from 'vitest';
import { SKIPPABLE_CODES, gatewayErrorFromBody, statusFor } from '../src/core/errors.ts';

describe('the plan request codes stop the request with their own status (P3, D6)', () => {
  it('answers sign_in_required with 401, plan_use_not_enabled with 403 and plan_usage_paused with 429 whatever the type', () => {
    expect(statusFor('invalid_request', 'sign_in_required')).toBe(401);
    expect(statusFor('invalid_request', 'plan_use_not_enabled')).toBe(403);
    expect(statusFor('invalid_request', 'plan_usage_paused')).toBe(429);
    expect(statusFor('server_error', 'plan_usage_paused')).toBe(429);
  });

  it.each([
    ['sign_in_required', 'invalid_request', 401],
    ['plan_use_not_enabled', 'invalid_request', 403],
    ['plan_usage_paused', 'too_many_requests', 429],
    ['plan_store_unreadable', 'server_error', 500],
    ['plan_store_unwritable', 'server_error', 500],
  ] as const)('answers %s, of type %s, with status %i', (code, type, status) => {
    expect(statusFor(type, code)).toBe(status);
    expect(statusFor('model_error', code)).toBe(status);
    expect(gatewayErrorFromBody({ type, code, message: code, param: null }).status).toBe(status);
  });

  it('lists none of them as skippable', () => {
    expect(statusFor('server_error', 'sign_in_required')).toBe(401);
    for (const code of ['sign_in_required', 'plan_usage_paused', 'plan_use_not_enabled', 'plan_store_unreadable', 'plan_store_unwritable']) {
      expect(SKIPPABLE_CODES.has(code)).toBe(false);
    }
  });
});
