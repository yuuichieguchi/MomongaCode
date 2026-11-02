import { describe, expect, it } from 'vitest';
import { MAX_GLOB_MATCHES, expandGlobWord } from '../src/glob-expansion.ts';

const HOME = '/home/user';
const CWD = '/work/project';

const withMatches = (matches: readonly string[]) => ({
  fs: { expandGlob: (_pattern: string, _cwd: string, _limit: number) => ({ matches: [...matches] }) },
  cwd: CWD,
  home: HOME,
});

describe('expandGlobWord, the one expansion of decide and the approval', () => {
  it('expands braces first, then globs every word, and reports each match as an absolute path', () => {
    const asked: string[] = [];
    const context = {
      fs: {
        expandGlob: (pattern: string, _cwd: string, limit: number) => {
          asked.push(`${pattern}@${limit}`);
          return { matches: pattern === 'a/*.ts' ? ['a/x.ts', 'a/y.ts'] : [] };
        },
      },
      cwd: CWD,
      home: HOME,
    };
    expect(expandGlobWord(context, '{a,b}/*.ts')).toEqual([
      { kind: 'match', text: 'a/x.ts', absolute: '/work/project/a/x.ts' },
      { kind: 'match', text: 'a/y.ts', absolute: '/work/project/a/y.ts' },
      { kind: 'path', text: 'b/*.ts', absolute: '/work/project/b/*.ts' },
    ]);
    expect(asked).toEqual([`a/*.ts@${MAX_GLOB_MATCHES}`, `b/*.ts@${MAX_GLOB_MATCHES}`]);
  });

  it('reads a brace word without glob characters as paths, without asking the filesystem', () => {
    const context = {
      fs: {
        expandGlob: () => {
          throw new Error('must not glob');
        },
      },
      cwd: CWD,
      home: HOME,
    };
    expect(expandGlobWord(context, '{a,b}')).toEqual([
      { kind: 'path', text: 'a', absolute: '/work/project/a' },
      { kind: 'path', text: 'b', absolute: '/work/project/b' },
    ]);
  });

  it('roots a leading tilde at the home and refuses another user', () => {
    expect(expandGlobWord(withMatches([]), '~/notes')).toEqual([{ kind: 'path', text: '/home/user/notes', absolute: '/home/user/notes' }]);
    expect(expandGlobWord(withMatches([]), '~root/*')).toEqual([{ kind: 'unresolvable', reason: { kind: 'other-user-home' } }]);
  });

  it('reports a brace overflow, a glob overflow and an unresolvable directory as unresolvable', () => {
    expect(expandGlobWord(withMatches([]), '{1..100000}')).toEqual([{ kind: 'unresolvable', reason: { kind: 'dynamic' } }]);
    const overflowing = { fs: { expandGlob: () => ({ overflow: true as const }) }, cwd: CWD, home: HOME };
    expect(expandGlobWord(overflowing, '*')).toEqual([{ kind: 'unresolvable', reason: { kind: 'dynamic' } }]);
    const blocked = { fs: { expandGlob: () => ({ unresolvable: { kind: 'cwd-changed' as const } }) }, cwd: CWD, home: HOME };
    expect(expandGlobWord(blocked, '*')).toEqual([{ kind: 'unresolvable', reason: { kind: 'cwd-changed' } }]);
  });
});
