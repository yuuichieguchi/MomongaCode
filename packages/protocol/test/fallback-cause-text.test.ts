import { describe, expect, it } from 'vitest';
import { describeFallbackCauseOn } from '@momonga/protocol';
import type { FallbackCause } from '@momonga/protocol';

const refused: FallbackCause = { target: 'openai/gpt-5.5', name: 'gpt-5.5', code: 'billing_change_refused', message: 'not tried', fromBilling: 'plan', toBilling: 'metered', reason: 'billing_change_refused' };

describe('the sentence of a fallback refused for its billing change', () => {
  it('the terminal UI gives the design sentence with /models billing', () => {
    expect(describeFallbackCauseOn(refused, 'tui')).toBe('Did not fall back to gpt-5.5: billing from plan to metered is not allowed. Run /models billing.');
  });

  it('the shell gives the design sentence with the shell command that allows the change', () => {
    const text = describeFallbackCauseOn(refused, 'cli');
    expect(text).toBe('Did not fall back to gpt-5.5: billing from plan to metered is not allowed. Run momonga models billing allow plan metered.');
    expect(text).not.toContain('/models');
  });
});
