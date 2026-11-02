import { describe, expect, it } from 'vitest';
import { describeMemoryValidity } from '@momonga/protocol';

const base = { state: 'active' as const, retiredAt: null, supersedes: [], supersededBy: [] };

describe('describeMemoryValidity', () => {
  it('says nothing about a note that is live and replaces nothing', () => {
    expect(describeMemoryValidity(base)).toBe('');
  });

  it('names the state, the retirement and both directions of replacement, in that order', () => {
    expect(describeMemoryValidity({ state: 'archived', retiredAt: Date.UTC(1970, 0, 2), supersedes: ['m1', 'm2'], supersededBy: ['m9'] })).toBe(
      ', state archived, retired 1970-01-02T00:00:00.000Z, supersedes m1 m2, superseded by m9',
    );
  });

  it('marks a replaced note even when nothing else is wrong with it', () => {
    expect(describeMemoryValidity({ ...base, supersededBy: ['m9'] })).toBe(', superseded by m9');
  });
});
