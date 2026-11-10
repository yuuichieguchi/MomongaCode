import { describe, expect, it } from 'vitest';
import { PLAN_PROFILES } from '@momonga/config';
import * as protocol from '@momonga/protocol';

const usageLimitCodes = (): readonly string[] => (protocol as unknown as { USAGE_LIMIT_CODES: readonly string[] }).USAGE_LIMIT_CODES;

describe('USAGE_LIMIT_CODES is defined once and follows the profiles (P3c drift test)', () => {
  it('holds exactly the three usage codes', () => {
    expect([...usageLimitCodes()]).toEqual(['plan_usage_limit', 'plan_workspace_usage_limit', 'plan_usage_paused']);
  });

  it('equals the codes of every shipped profile rule whose credential effect is pause, plus plan_usage_paused', () => {
    const paused = new Set<string>(['plan_usage_paused']);
    for (const profile of Object.values(PLAN_PROFILES)) {
      for (const rule of profile.errorRules) if (rule.credential === 'pause') paused.add(rule.code);
    }
    expect(new Set(usageLimitCodes())).toEqual(paused);
  });

  it('adds usage_limit to STOP_REASONS', () => {
    expect(protocol.STOP_REASONS as readonly string[]).toContain('usage_limit');
  });
});
