import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.ts';

const EXPECTED_CODES = {
  USAGE_LIMIT_CODE: 'plan_usage_limit',
  WORKSPACE_USAGE_LIMIT_CODE: 'plan_workspace_usage_limit',
  USAGE_PAUSED_CODE: 'plan_usage_paused',
  SIGN_IN_REQUIRED_CODE: 'sign_in_required',
  PLAN_USE_NOT_ENABLED_CODE: 'plan_use_not_enabled',
  PLAN_NOT_ELIGIBLE_CODE: 'plan_not_eligible',
  PLAN_STORE_UNREADABLE_CODE: 'plan_store_unreadable',
  PLAN_STORE_UNWRITABLE_CODE: 'plan_store_unwritable',
  PLAN_HOST_IDENTITY_UNAVAILABLE_CODE: 'plan_host_identity_unavailable',
  PLAN_CREDENTIAL_UNAVAILABLE_CODE: 'plan_credential_unavailable',
  PLAN_ACCOUNT_NOT_SELECTABLE_CODE: 'plan_account_not_selectable',
  PLAN_SIGN_IN_PENDING_CODE: 'plan_sign_in_pending',
  PLAN_SIGN_OUT_IN_PROGRESS_CODE: 'plan_sign_out_in_progress',
  CAPABILITIES_UNKNOWN_CODE: 'capabilities_unknown',
};

const exported = protocol as unknown as Record<string, unknown>;

describe('the plan codes are protocol constants', () => {
  it('the fourteen constants have their exact values', () => {
    expect(Object.fromEntries(Object.keys(EXPECTED_CODES).map((name) => [name, exported[name]]))).toEqual(EXPECTED_CODES);
  });

  it('USAGE_LIMIT_CODES is built from the three usage constants', () => {
    expect(protocol.USAGE_LIMIT_CODES).toEqual([exported['USAGE_LIMIT_CODE'], exported['WORKSPACE_USAGE_LIMIT_CODE'], exported['USAGE_PAUSED_CODE']]);
    expect(protocol.USAGE_LIMIT_CODES).toEqual(['plan_usage_limit', 'plan_workspace_usage_limit', 'plan_usage_paused']);
  });

  it('PLAN_CODES has the fourteen distinct members', () => {
    const codes = exported['PLAN_CODES'];
    expect(Array.isArray(codes)).toBe(true);
    expect(new Set(codes as string[])).toEqual(new Set(Object.values(EXPECTED_CODES)));
    expect((codes as string[]).length).toBe(14);
  });
});
