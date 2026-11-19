import { describe, expect, it } from 'vitest';
import { fallbackNoticeText, fallbackNoticeTextOn } from '../src/index.ts';
import type { FallbackNotice } from '../src/index.ts';

const refusedBilling: FallbackNotice = {
  target: 'secondary',
  causes: [
    { target: 'primary', code: 'provider_unavailable', message: 'the upstream is unreachable' },
    { target: 'metered', name: 'metered', code: null, message: 'billing refused', reason: 'billing_change_refused', fromBilling: 'plan', toBilling: 'metered' },
  ],
};

const rejectedPlan: FallbackNotice = {
  target: 'secondary',
  causes: [{ target: 'primary', code: 'plan_credential_rejected', message: 'the plan credential was rejected' }],
};

describe('the fallback notice text', () => {
  it('is stored with no surface remedy', () => {
    expect(fallbackNoticeText(refusedBilling)).toBe(
      'The model call was answered by the fallback model secondary because primary failed (provider_unavailable: the upstream is unreachable). Did not fall back to metered: billing from plan to metered is not allowed.',
    );
    expect(fallbackNoticeText(rejectedPlan)).not.toMatch(/\/login|auth login/);
  });

  it('adds the billing remedy of the surface at display', () => {
    expect(fallbackNoticeTextOn(refusedBilling, 'tui')).toBe(`${fallbackNoticeText(refusedBilling)} Allow it with /model, then Model settings…, then Billing changes.`);
  });

  it('adds the sign-in remedy of the surface for a rejected plan credential', () => {
    expect(fallbackNoticeTextOn(rejectedPlan, 'tui')).toBe(`${fallbackNoticeText(rejectedPlan)} Run /login to sign in again.`);
    expect(fallbackNoticeTextOn(rejectedPlan, 'cli')).toMatch(/ Run .* auth login to sign in again\.$/);
  });
});
