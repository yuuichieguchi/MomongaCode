import { describe, expect, it } from 'vitest';
import { PLAN_HEALTH_REASONS, TARGET_HEALTH_REASONS } from '../src/index.ts';

describe('health reasons are owned by protocol', () => {
  it('TARGET_HEALTH_REASONS lists the eight target health reasons in order', () => {
    expect(TARGET_HEALTH_REASONS).toEqual(['not_running', 'unhealthy', 'precondition_failed', 'health_check_failed', 'sign_in_required', 'store_unreadable', 'store_unwritable', 'capabilities_unknown']);
  });

  it('PLAN_HEALTH_REASONS lists the five plan health reasons in order', () => {
    expect(PLAN_HEALTH_REASONS).toEqual(['sign_in_required', 'plan_use_not_enabled', 'plan_usage_paused', 'store_unreadable', 'store_unwritable']);
  });
});
