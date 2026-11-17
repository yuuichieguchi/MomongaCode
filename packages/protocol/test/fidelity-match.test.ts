import { describe, expect, it } from 'vitest';
import { tokenMatcherOf } from '../src/fidelity-match.ts';

const CWD = '/proj';

describe('tokenMatcherOf folder rule for path tokens', () => {
  it('matches an absolute path under the session cwd against a relative record', () => {
    expect(tokenMatcherOf('/proj/lib/b.ts', CWD).matches('lib/b.ts', true)).toBe(true);
  });

  it('does not match /other/lib/b.ts against a record that holds lib/b.ts', () => {
    expect(tokenMatcherOf('/other/lib/b.ts', CWD).matches('lib/b.ts', true)).toBe(false);
  });

  it('does not match a/b.ts inside xa/b.ts in recorded text', () => {
    expect(tokenMatcherOf('a/b.ts', CWD).matches('wrote xa/b.ts', true)).toBe(false);
  });

  it('matches a/b.ts at a path-segment boundary in recorded text', () => {
    expect(tokenMatcherOf('a/b.ts', CWD).matches('wrote ./a/b.ts and more', true)).toBe(true);
  });

  it('does not match on a two-segment suffix of a different path', () => {
    expect(tokenMatcherOf('/elsewhere/src/a.ts', CWD).matches('changed src/a.ts', true)).toBe(false);
  });
});
