import { describe, expect, it } from 'vitest';
import { fileMatcherOf, parseFilePattern, testFileMatcher } from '@momonga/foundation';
import type { FilePatternContext } from '@momonga/foundation';

type MatcherForm = Parameters<typeof fileMatcherOf>[2];

const context: FilePatternContext = { roots: ['/w'], home: '/h', settingsRoot: '/s', effect: 'deny' };

const accepts = (specifier: string, candidate: string, form: MatcherForm = 'exact', ignoreCase = false): boolean =>
  parseFilePattern(specifier, context).some((pattern) => {
    const verdict = testFileMatcher(fileMatcherOf(pattern, pattern.directory, form), candidate, ignoreCase);
    return verdict.own || verdict.below;
  });

describe('file rules are matched over path segments without a backtracking regular expression', () => {
  it('answers a rule of thirty stars against a twenty thousand character segment that does not match', () => {
    const rule = `//w/${'*a'.repeat(30)}b`;
    const candidate = `/w/${'a'.repeat(20_000)}`;
    for (const form of ['exact', 'deny', 'subset'] as const) expect(accepts(rule, candidate, form)).toBe(false);
    expect(accepts(rule, `${candidate}b`)).toBe(true);
  });

  it('answers a rule of many globstars against a deep path that does not match', () => {
    const rule = `//w/${'**/a/'.repeat(12)}b`;
    const candidate = `/w/${'a/'.repeat(400)}c`;
    expect(accepts(rule, candidate)).toBe(false);
    expect(accepts(rule, `/w/${'a/'.repeat(400)}b`)).toBe(true);
  });

  it('never lets a star cross a slash', () => {
    expect(accepts('//w/a*b', '/w/a/b')).toBe(false);
    expect(accepts('//w/a*b', '/w/axyzb')).toBe(true);
    expect(accepts('//w/*.ts', '/w/src/a.ts')).toBe(false);
  });

  it('keeps the results of ?, classes, negated classes and case folding', () => {
    expect(accepts('//w/a?c', '/w/abc')).toBe(true);
    expect(accepts('//w/a?c', '/w/a/c')).toBe(false);
    expect(accepts('//w/a?c', '/w/ac')).toBe(false);
    expect(accepts('//w/[a-c]x', '/w/bx')).toBe(true);
    expect(accepts('//w/[a-c]x', '/w/dx')).toBe(false);
    expect(accepts('//w/[!a-c]x', '/w/dx')).toBe(true);
    expect(accepts('//w/[!a-c]x', '/w/ax')).toBe(false);
    expect(accepts('//w/[[:digit:]]x', '/w/7x')).toBe(true);
    expect(accepts('//w/Secret*', '/w/secret.txt', 'exact', true)).toBe(true);
    expect(accepts('//w/Secret*', '/w/secret.txt', 'exact', false)).toBe(false);
  });

  it('matches below a rule and through a trailing globstar', () => {
    expect(accepts('//w/a/b', '/w/a/b/c/d')).toBe(true);
    expect(accepts('//w/a/**', '/w/a')).toBe(true);
    expect(accepts('//w/**/x', '/w/x')).toBe(true);
    expect(accepts('//w/**/x', '/w/p/q/x')).toBe(true);
    expect(accepts('//w/**/x', '/v/x')).toBe(false);
  });
});

describe('the segment matcher answers as the kernel expression of its form', () => {
  const specifiers = ['//w/a?b', '//w/note*', '//w/a[!e]b', '//w/[!a]b', '//w/a[à-ÿ]b', '//w/[[:alpha:]]*.ts', '//w/**/x/*', '//w/a/**/b?', '//w/x*y*z'];
  const names = ['/w/aXb', '/w/aéb', '/w/aéb', '/w/àb', '/w/Xb', '/w/aeb', '/w/aæb', '/w/note', '/w/notes', '/w/noté', '/w/ab.ts', '/w/p/x/q', '/w/x/q/r', '/w/a/b1', '/w/a/c/d/b2', '/w/xyz', '/w/xay/z', '/w/xxyyzz/k'];

  it.each(specifiers)('%s', (specifier) => {
    for (const pattern of parseFilePattern(specifier, context)) {
      for (const form of ['exact', 'deny', 'subset'] as const) {
        const matcher = fileMatcherOf(pattern, pattern.directory, form);
        for (const name of names) {
          for (const tail of ['own', 'below'] as const) {
            const expression = matcher[tail];
            const kernel = expression.kind === 'regex' ? new RegExp(expression.source, 'su').test(name.normalize('NFC')) : undefined;
            if (kernel !== undefined) expect([form, tail, name, testFileMatcher(matcher, name, false)[tail]]).toEqual([form, tail, name, kernel]);
          }
        }
      }
    }
  });
});
