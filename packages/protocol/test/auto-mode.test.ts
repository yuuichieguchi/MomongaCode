import { describe, expect, it } from 'vitest';
import { AUTO_MODE_UNAVAILABLE, classifierAllows } from '@momonga/protocol';

describe('auto mode classifier verdict', () => {
  it('allows only a safe verdict with high confidence', () => {
    const allowed = [
      { verdict: 'safe', confidence: 'high' },
      { verdict: 'safe', confidence: 'medium' },
      { verdict: 'safe', confidence: 'low' },
      { verdict: 'unsafe', confidence: 'high' },
      { verdict: 'unsafe', confidence: 'low' },
    ] as const;
    expect(allowed.map((entry) => classifierAllows({ ...entry, rationale: '' }))).toEqual([true, false, false, false, false]);
  });

  it('carries the unavailable code and no sentence that says auto needs a classifier model', () => {
    expect(AUTO_MODE_UNAVAILABLE).toEqual({ code: 'mode_unavailable' });
  });
});
