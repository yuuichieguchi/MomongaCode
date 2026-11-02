import { describe, expect, it } from 'vitest';
import { expandGlobWord } from '../src/glob-expansion.ts';
import { escapeForGlob, firstUnescaped, unescapeGlob } from '../src/glob-pattern.ts';
import { analyzeCommand, programNameOf } from '../src/shell.ts';
import type { Analysis } from '../src/shell.ts';

const lastWord = (command: string) => {
  const analysis = analyzeCommand(command) as Analysis;
  return (analysis.segments[0]?.words ?? []).at(-1);
};

const namesOf = (analysis: Analysis): string[] => [
  ...analysis.segments.flatMap((segment) => programNameOf(segment) ?? []),
  ...analysis.nested.flatMap(namesOf),
];

describe('the scanner carries per-character quoting in the glob pattern', () => {
  it.each([
    ['cat "[a]"*', '\\[a\\]*'],
    ["cat '[a]'*", '\\[a\\]*'],
    ['cat \\[a\\]*', '\\[a\\]*'],
    ['cat l[[:alpha:]]k', 'l[[:alpha:]]k'],
    ["cat 'a b'*", 'a\\ b*'],
    ['cat "a"?"b"', 'a?b'],
    ['cat .*/x', '.*/x'],
    ['cat [z-a]*', '[z-a]*'],
  ])('%s gives %j', (command, pattern) => {
    expect(lastWord(command)?.glob).toBe(pattern);
  });

  it('leaves a word with a substitution without a pattern, because its structure is not established', () => {
    expect(lastWord('cat $X*')?.glob).toBeNull();
    expect(lastWord('cat $(echo a)*')?.glob).toBeNull();
    expect(lastWord('cat plain')?.glob).toBeNull();
  });
});

describe('a backtick substitution inside double quotes unescapes a backslash before a double quote as bash does', () => {
  it('finds the command hidden behind \\" in the substitution body', () => {
    const analysis = analyzeCommand('echo "`echo \\"\'\\"; touch pwn1; echo \\"\'\\"`"') as Analysis;
    expect(namesOf(analysis)).toEqual(['echo', 'echo', 'touch', 'echo']);
  });

  it('keeps a backslash before a double quote in a backtick substitution outside double quotes', () => {
    const analysis = analyzeCommand('echo `echo \\"a b\\"`') as Analysis;
    expect(namesOf(analysis)).toEqual(['echo', 'echo']);
  });
});

describe('glob pattern helpers', () => {
  it('escapes every character that is not a plain path character, and unescapes it again', () => {
    for (const text of ['a b', '[a]*?', 'x\\y', 'plain/path-1.txt', '~', '$HOME']) expect(unescapeGlob(escapeForGlob(text))).toBe(text);
    expect(escapeForGlob('plain/path-1.txt')).toBe('plain/path-1.txt');
  });

  it('finds only unescaped special characters', () => {
    expect(firstUnescaped('\\*a*', '*')).toBe(3);
    expect(firstUnescaped('\\\\*', '*')).toBe(2);
    expect(firstUnescaped('\\*\\?', '*?')).toBe(-1);
  });
});

describe('expandGlobWord hands the escaped pattern to the filesystem and reads back real names', () => {
  const asked: string[] = [];
  const context = (matches: string[]) => ({
    fs: {
      expandGlob: (pattern: string) => {
        asked.push(pattern);
        return { matches };
      },
    },
    cwd: '/work',
    home: '/home/a[b]',
  });

  it('escapes the home directory in a tilde pattern', () => {
    asked.length = 0;
    expandGlobWord(context([]), '~/n*');
    expect(asked).toEqual(['/home/a\\[b\\]/n*']);
  });

  it('reports an unmatched word as the literal path with the quoting removed', () => {
    expect(expandGlobWord(context([]), '\\[a\\]x*')).toEqual([{ kind: 'path', text: '[a]x*', absolute: '/work/[a]x*' }]);
  });

  it('does not ask the filesystem about a word whose only special characters are escaped', () => {
    asked.length = 0;
    expect(expandGlobWord(context([]), '\\[a\\]')).toEqual([{ kind: 'path', text: '[a]', absolute: '/work/[a]' }]);
    expect(asked).toEqual([]);
  });

  it('does not read an escaped brace as a brace expansion', () => {
    expect(expandGlobWord(context([]), '\\{a,b\\}')).toEqual([{ kind: 'path', text: '{a,b}', absolute: '/work/{a,b}' }]);
  });
});
