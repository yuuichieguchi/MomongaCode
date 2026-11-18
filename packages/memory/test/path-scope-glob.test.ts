import { describe, expect, it } from 'vitest';
import { pathScopeMatcherOf } from '@momonga/memory';

const PROJECT = '/work/a';

describe('the path scope of a governing fact', () => {
  it('matches ordinary globs as before', () => {
    const matches = pathScopeMatcherOf(PROJECT, ['src/**/[a-c]*.{ts,tsx}', '.github/**']);
    expect(['/work/a/src/x/b.tsx', '/work/a/.github/workflows/ci.yml', '/work/a/src/d.ts', '/work/b/src/a.ts', '/work/a'].map(matches)).toEqual([true, true, false, false, false]);
  });

  it.each([['+(a)+(a)+(a)'], ['((a)+)+b'], ['(a|a)+b'], ['{a,{a,b}+}+'], ['!src/**']])('never matches with the unsupported glob %s and does not throw', (glob) => {
    const matches = pathScopeMatcherOf(PROJECT, [glob]);
    expect(['/work/a/aaa', '/work/a/ab', '/work/a/src/a.ts', '/work/a/x'].map(matches)).toEqual([false, false, false, false]);
  });

  it('still matches through the supported globs beside an unsupported one', () => {
    const matches = pathScopeMatcherOf(PROJECT, ['+(a)', 'docs/*.md']);
    expect([matches('/work/a/docs/x.md'), matches('/work/a/a')]).toEqual([true, false]);
  });
});
