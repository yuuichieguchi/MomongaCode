import { describe, expect, it } from 'vitest';
import { PLAN_PROFILES } from '@momonga/config';
import { PLAN_CODES, PLAN_NOT_ELIGIBLE_CODE, USAGE_LIMIT_CODE, WORKSPACE_USAGE_LIMIT_CODE } from '@momonga/protocol';

describe('F8: a code the product matches by its protocol constant is the code the profile data names', () => {
  it('the shipped profile rules name, among the protocol plan codes, exactly the usage limit codes and plan_not_eligible', () => {
    const named = new Set(Object.values(PLAN_PROFILES).flatMap((profile) => profile.errorRules.map((rule) => rule.code)));
    const matched = (PLAN_CODES as readonly string[]).filter((code) => named.has(code));
    expect(new Set(matched)).toEqual(new Set([USAGE_LIMIT_CODE, WORKSPACE_USAGE_LIMIT_CODE, PLAN_NOT_ELIGIBLE_CODE]));
  });
});
