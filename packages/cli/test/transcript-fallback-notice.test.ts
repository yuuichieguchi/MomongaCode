import { describe, expect, it } from 'vitest';
import { fold } from './tui/screen-fakes.ts';

const refusedNotice = {
  type: 'notice',
  level: 'warning',
  code: 'fallback_target',
  message:
    'The model call was answered by the fallback model secondary because primary failed (provider_unavailable: the upstream is unreachable). Did not fall back to metered: billing from plan to metered is not allowed.',
  fallback: {
    target: 'secondary',
    causes: [
      { target: 'primary', code: 'provider_unavailable', message: 'the upstream is unreachable' },
      { target: 'metered', name: 'metered', code: null, message: 'billing refused', reason: 'billing_change_refused', fromBilling: 'plan', toBilling: 'metered' },
    ],
  },
};

describe('the fallback notice in the terminal transcript', () => {
  it('adds the surface remedy from the structured cause at display', () => {
    const state = fold([refusedNotice]);
    expect(state.entries).toEqual([
      expect.objectContaining({
        kind: 'notice',
        level: 'warning',
        text: `${refusedNotice.message} Run /models billing.`,
      }),
    ]);
  });

  it('shows a stored notice without its structured cause as stored', () => {
    const { fallback: _structured, ...stored } = refusedNotice;
    const state = fold([stored]);
    expect(state.entries).toEqual([expect.objectContaining({ kind: 'notice', text: refusedNotice.message })]);
  });
});
