import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeFallbackCause, describeFallbackCauseOn } from '../src/fallback-cause.ts';
import type { FallbackCause } from '../src/fallback-cause.ts';

const MODEL_STEP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../runtime/src/worker/model-step.ts');

describe('one renderer of a fallback cause covers billing records (P3, M9)', () => {
  it('renders a refused billing change as the member that was not tried', () => {
    const refused = { target: 'metered', code: 'billing_change_refused', message: 'not tried', fromBilling: 'plan', toBilling: 'metered', reason: 'billing_change_refused' } as FallbackCause;
    expect(describeFallbackCause(refused)).toBe('Did not fall back to metered: billing from plan to metered is not allowed.');
    expect(describeFallbackCauseOn(refused, 'tui')).toBe('Did not fall back to metered: billing from plan to metered is not allowed. Run /models billing.');
  });

  it('renders an allowed change as the failure of the member left, naming both billing kinds', () => {
    const allowed = { target: 'plan', code: 'upstream_error', message: 'plan is unavailable', fromBilling: 'plan', toBilling: 'metered', reason: 'billing_change_allowed' } as FallbackCause;
    const text = describeFallbackCause(allowed);
    expect(text.startsWith('plan failed (upstream_error: plan is unavailable)')).toBe(true);
    expect(text).toContain('from plan to metered billing');
  });

  it('is the renderer the fallback_target notice of model-step uses', () => {
    const source = fs.readFileSync(MODEL_STEP, 'utf8');
    expect(source).toContain('describeFallbackCause');
    expect(source).not.toContain('failed (${');
  });
});
