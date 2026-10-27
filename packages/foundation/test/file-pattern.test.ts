import { describe, expect, it } from 'vitest';
import { FileRuleError, checkFilePatternGrammar, fileMatcherOf, parseFilePattern, testFileMatcher } from '@momonga/foundation';
import type { FilePatternContext } from '@momonga/foundation';

const CWD = '/w';
const EXTRA = '/e';
const HOME = '/h';
const SETTINGS_ROOT = '/s';

const NON_ASCII_BYTE = `[^${String.fromCharCode(0x01)}-${String.fromCharCode(0x7f)}]`;
const ASCII_BYTE_EXCEPT_SLASH = `[${String.fromCharCode(0x01)}-.0-${String.fromCharCode(0x7f)}]`;

type Effect = FilePatternContext['effect'];

const contextFor = (effect: Effect, roots: readonly string[] = [CWD, EXTRA]): FilePatternContext => ({ roots, home: HOME, settingsRoot: SETTINGS_ROOT, effect });

const exactBlocks = (specifier: string, effect: Effect, candidate: string): boolean =>
  parseFilePattern(specifier, contextFor(effect)).some((pattern) => {
    const verdict = testFileMatcher(fileMatcherOf(pattern, pattern.directory, 'exact'), candidate, false);
    return verdict.own || verdict.below;
  });

const onlyPattern = (specifier: string) => {
  const patterns = parseFilePattern(specifier, contextFor('deny'));
  expect(patterns).toHaveLength(1);
  return patterns[0] as (typeof patterns)[number];
};

const kernelBytes = (name: string): string => Buffer.from(name.normalize('NFD')).toString('latin1');

const regexSource = (expression: { kind: string; path?: string; source?: string }): string => {
  expect(expression.kind).toBe('regex');
  return expression.source as string;
};

const kernelAccepts = (specifier: string, form: 'deny' | 'subset', name: string): boolean => {
  const pattern = onlyPattern(specifier);
  const matcher = fileMatcherOf(pattern, pattern.directory, form);
  if (matcher.own.kind === 'none') return false;
  if (matcher.own.kind === 'subpath') {
    const base = kernelBytes(matcher.own.path);
    const target = kernelBytes(name);
    return target === base || target.startsWith(`${base}/`);
  }
  return new RegExp(kernelBytes(regexSource(matcher.own)), 's').test(kernelBytes(name));
};

const exactAccepts = (specifier: string, name: string): boolean => {
  const pattern = onlyPattern(specifier);
  return testFileMatcher(fileMatcherOf(pattern, pattern.directory, 'exact'), name, false).own;
};

describe('parseFilePattern anchoring', () => {
  it.each([
    ['//abs/p', ['/abs/p']],
    ['~', [HOME]],
    ['~/n/k', [`${HOME}/n/k`]],
    ['/docs/a', [`${SETTINGS_ROOT}/docs/a`]],
    ['./x/y', [`${CWD}/x/y`, `${EXTRA}/x/y`]],
    ['a/b', [`${CWD}/a/b`, `${EXTRA}/a/b`]],
    ['a', [CWD, EXTRA]],
  ])('anchors deny %s at %j', (specifier, directories) => {
    expect(parseFilePattern(specifier, contextFor('deny')).map((pattern) => pattern.directory)).toEqual(directories);
  });

  it.each([
    ['//abs/p', 0],
    ['~/n/k', 0],
    ['./x/y', 0],
    ['a', 2],
    ['src/**', 3],
    ['a/**/b', 2],
    ['**/**/x/**/**', 3],
  ])('gives %s a rest of %i segments after the depth rule and globstar collapsing', (specifier, length) => {
    for (const pattern of parseFilePattern(specifier, contextFor('deny'))) expect(pattern.rest).toHaveLength(length);
  });

  it('anchors the relative forms of an allow rule at the cwd only', () => {
    expect(parseFilePattern('a', contextFor('allow')).map((pattern) => pattern.directory)).toEqual([CWD]);
    expect(parseFilePattern('./x/y', contextFor('allow')).map((pattern) => pattern.directory)).toEqual([`${CWD}/x/y`]);
    expect(parseFilePattern('src/**', contextFor('allow')).map((pattern) => pattern.directory)).toEqual([`${CWD}/src`]);
  });

  it('anchors the relative forms of an ask rule at every root', () => {
    expect(parseFilePattern('a', contextFor('ask')).map((pattern) => pattern.directory)).toEqual([CWD, EXTRA]);
  });
});

type DepthRow = [specifier: string, candidate: string, denyAndAsk: boolean, allow: boolean];

const DEPTH_TABLE: DepthRow[] = [
  ['.env', '/w/.env', true, true],
  ['.env', '/w/sub/.env', true, true],
  ['.env', '/e/sub/.env', true, false],
  ['.env', '/elsewhere/.env', false, false],
  ['.env', '/w/.env/inner', true, true],
  ['.env', '/w/a.env', false, false],
  ['*.pem', '/w/a/k.pem', true, true],
  ['*.pem', '/e/k.pem', true, false],
  ['*.pem', '/elsewhere/k.pem', false, false],
  ['src', '/w/v/src/f', true, true],
  ['src', '/e/src', true, false],
  ['src/**', '/w/src/f', true, true],
  ['src/**', '/w/src', true, true],
  ['src/**', '/w/vendor/src/f', true, false],
  ['src/**', '/e/src/f', true, false],
  ['src/**', '/w/srcx/f', false, false],
  ['s*/**', '/w/sx/f', true, true],
  ['s*/**', '/w/v/sy/f', true, false],
  ['s*/**', '/w/a/f', false, false],
  ['./src/**', '/w/src/f', true, true],
  ['./src/**', '/w/vendor/src/f', true, false],
  ['src/*.ts', '/w/src/a.ts', true, true],
  ['src/*.ts', '/w/vendor/src/a.ts', false, false],
  ['src/*.ts', '/e/src/a.ts', true, false],
  ['src/*.ts', '/w/src/d/a.ts', false, false],
  ['src/a/**', '/w/src/a/k', true, true],
  ['src/a/**', '/w/v/src/a/k', false, false],
  ['src/a/**', '/e/src/a/k', true, false],
  ['a/**/b', '/w/a/b', true, true],
  ['a/**/b', '/w/a/x/y/b', true, true],
  ['a/**/b', '/w/q/a/b', false, false],
  ['a/b', '/w/a/b', true, true],
  ['a/b', '/w/a/b/c', true, true],
  ['a/b', '/w/q/a/b', false, false],
  ['**/x/**', '/w/x/k', true, true],
  ['**/x/**', '/w/q/x/k', true, true],
  ['**/x/**', '/e/q/x/k', true, false],
];

describe('depth rules per shape', () => {
  it.each(DEPTH_TABLE)('%s against %s: deny and ask %s, allow %s', (specifier, candidate, denyAndAsk, allow) => {
    expect(exactBlocks(specifier, 'deny', candidate)).toBe(denyAndAsk);
    expect(exactBlocks(specifier, 'ask', candidate)).toBe(denyAndAsk);
    expect(exactBlocks(specifier, 'allow', candidate)).toBe(allow);
  });
});

describe('kernel regex pins', () => {
  it('translates ? as [^/]N* in the deny form and as one ASCII byte in the subset form', () => {
    const pattern = onlyPattern('//p/a?b');
    expect(regexSource(fileMatcherOf(pattern, '/p', 'deny').own)).toBe(`^/p/a[^/]${NON_ASCII_BYTE}*b$`);
    expect(regexSource(fileMatcherOf(pattern, '/p', 'deny').below)).toBe(`^/p/a[^/]${NON_ASCII_BYTE}*b/.+$`);
    expect(regexSource(fileMatcherOf(pattern, '/p', 'subset').own)).toBe(`^/p/a${ASCII_BYTE_EXCEPT_SLASH}b$`);
  });

  it('translates a leading * as [^/]* in both forms', () => {
    const pattern = onlyPattern('//p/*.pem');
    expect(regexSource(fileMatcherOf(pattern, '/p', 'deny').own)).toBe('^/p/[^/]*\\.pem$');
    expect(regexSource(fileMatcherOf(pattern, '/p', 'subset').own)).toBe('^/p/[^/]*\\.pem$');
  });

  it('continues a * after an element with an ASCII byte in the subset form', () => {
    const pattern = onlyPattern('//p/note*');
    expect(regexSource(fileMatcherOf(pattern, '/p', 'deny').own)).toBe('^/p/note[^/]*$');
    expect(regexSource(fileMatcherOf(pattern, '/p', 'subset').own)).toBe(`^/p/note(${ASCII_BYTE_EXCEPT_SLASH}[^/]*)?$`);
  });

  it('translates a negated class into the decomposition-aware deny form', () => {
    const pattern = onlyPattern('//p/a[!e]b');
    expect(regexSource(fileMatcherOf(pattern, '/p', 'deny').own)).toBe(`^/p/a([^e/]${NON_ASCII_BYTE}*|[e]${NON_ASCII_BYTE}+)b$`);
  });

  it('names a whole subtree with subpath when the rest is only globstars', () => {
    const pattern = onlyPattern('//p/k/**');
    expect(fileMatcherOf(pattern, '/p/k', 'deny').own).toEqual({ kind: 'subpath', path: '/p/k' });
    expect(fileMatcherOf(pattern, '/p/k', 'exact').own).toEqual({ kind: 'subpath', path: '/p/k' });
  });

  it('treats an escaped star as part of the static prefix', () => {
    const pattern = onlyPattern('//p/x\\*');
    expect(pattern.directory).toBe('/p/x*');
    expect(fileMatcherOf(pattern, '/p/x*', 'deny').own).toEqual({ kind: 'subpath', path: '/p/x*' });
  });

  it('writes a leading globstar after an anchored directory as (.*/)?', () => {
    const pattern = onlyPattern('//p/a/**/b');
    expect(regexSource(fileMatcherOf(pattern, '/p/a', 'deny').own)).toBe('^/p/a/(.*/)?b$');
  });

  it('escapes braces as literal characters', () => {
    const pattern = onlyPattern('//p/{a,b}*');
    expect(regexSource(fileMatcherOf(pattern, '/p', 'deny').own)).toBe('^/p/\\{a,b\\}[^/]*$');
  });

  it('escapes the canonical directory', () => {
    const pattern = onlyPattern('//p.q(r)/*.pem');
    expect(regexSource(fileMatcherOf(pattern, '/p.q(r)', 'deny').own)).toBe('^/p\\.q\\(r\\)/[^/]*\\.pem$');
  });
});

type GrammarRow = [specifier: string, name: string, exact: boolean];

const GRAMMAR_TABLE: GrammarRow[] = [
  ['//p/a?b', 'acb', true],
  ['//p/a?b', 'ab', false],
  ['//p/a?b', 'accb', false],
  ['//p/a?b', 'aあb', true],
  ['//p/a?b', 'a😀b', true],
  ['//p/a?b', 'aéb', true],
  ['//p/a[!e]b', 'acb', true],
  ['//p/a[!e]b', 'aeb', false],
  ['//p/a[!e]b', 'aéb', true],
  ['//p/a[!e]b', 'aXb', true],
  ['//p/a[^e]b', 'aeb', false],
  ['//p/a[^e]b', 'aéb', true],
  ['//p/a[!n]b', 'añb', true],
  ['//p/a[!n]b', 'anb', false],
  ['//p/[!a]b', 'àb', true],
  ['//p/[!a]b', 'ab', false],
  ['//p/[]a]x', ']x', true],
  ['//p/[]a]x', 'ax', true],
  ['//p/[]a]x', 'bx', false],
  ['//p/a[b-d]e', 'ace', true],
  ['//p/a[b-d]e', 'aae', false],
  ['//p/a[b-d]e', 'ade', true],
  ['//p/[[:digit:]]x', '1x', true],
  ['//p/[[:digit:]]x', 'ax', false],
  ['//p/x\\*', 'x*', true],
  ['//p/x\\*', 'xy', false],
  ['//p/{a,b}', '{a,b}', true],
  ['//p/{a,b}', 'a', false],
  ['//p/*.pem', 'k.pem', true],
  ['//p/*.pem', '.pem', true],
  ['//p/*.pem', 'k.pemx', false],
  ['//p/note*', 'note', true],
  ['//p/note*', 'notex', true],
  ['//p/note*', 'noteあ', true],
  ['//p/note*', 'noté', false],
  ['//p/note*', 'not', false],
  ['//p/café', 'café', true],
  ['//p/café', 'café', true],
  ['//p/café', 'café', true],
  ['//p/ẍ?', 'ẍa', true],
  ['//p/a[!e]b', 'ae\u0331b', false],
  ['//p/a[!e]b', 'ae\u0301b', true],
  ['//p/[!a]b', 'a\u0331b', false],
  ['//p/[!a]b', 'a\u0300b', true],
  ['//p/a[à-ÿ]b', 'ae\u0301b', true],
  ['//p/a[à-ÿ]b', 'aeb', false],
  ['//p/a[à-ÿ]b', 'a\u00e6b', true],
];

const candidatePath = (name: string): string => `/p/${name}`;

describe('exact grammar verdicts', () => {
  it.each(GRAMMAR_TABLE)('%s against %s is %s', (specifier, name, exact) => {
    expect(exactAccepts(specifier, candidatePath(name))).toBe(exact);
  });
});

const isAscii = (name: string): boolean => [...name].every((character) => character.charCodeAt(0) < 0x80);

describe('kernel forms against the exact matcher', () => {
  it.each(GRAMMAR_TABLE)('the deny form of %s accepts %s whenever the exact form does, and equals it on ASCII names', (specifier, name) => {
    const exact = exactAccepts(specifier, candidatePath(name));
    const kernel = kernelAccepts(specifier, 'deny', candidatePath(name));
    if (exact) expect(kernel).toBe(true);
    if (isAscii(name)) expect(kernel).toBe(exact);
  });

  it.each(GRAMMAR_TABLE)('the subset form of %s accepts %s only when the exact form does', (specifier, name) => {
    const exact = exactAccepts(specifier, candidatePath(name));
    const kernel = kernelAccepts(specifier, 'subset', candidatePath(name));
    if (kernel) expect(exact).toBe(true);
  });

  it('the subset form of note* rejects not followed by a decomposed é', () => {
    expect(kernelAccepts('//p/note*', 'subset', '/p/noté')).toBe(false);
    expect(kernelAccepts('//p/note*', 'subset', '/p/note')).toBe(true);
    expect(kernelAccepts('//p/note*', 'subset', '/p/notex')).toBe(true);
  });

  it('kills the [^e/]N* mutant: the deny form of a[!e]b accepts aéb in its decomposed bytes', () => {
    const mutant = new RegExp(`^/p/a[^e/]${NON_ASCII_BYTE}*b$`, 's');
    expect(mutant.test(kernelBytes('/p/aéb'))).toBe(false);
    expect(kernelAccepts('//p/a[!e]b', 'deny', '/p/aéb')).toBe(true);
    expect(kernelAccepts('//p/a[!e]b', 'deny', '/p/aéb')).toBe(true);
    expect(kernelAccepts('//p/a[!n]b', 'deny', '/p/añb')).toBe(true);
    expect(kernelAccepts('//p/a[!n]b', 'deny', '/p/añb')).toBe(true);
    expect(kernelAccepts('//p/[!a]b', 'deny', '/p/àb')).toBe(true);
    expect(kernelAccepts('//p/[!a]b', 'deny', '/p/àb')).toBe(true);
    expect(kernelAccepts('//p/a[!e]b', 'deny', '/p/aeb')).toBe(false);
    expect(kernelAccepts('//p/a[!e]b', 'deny', '/p/aXb')).toBe(true);
  });
});

describe('negated classes and non-ASCII ranges in the kernel forms', () => {
  it('the subset form of a[!e]b rejects aéb in its decomposed bytes and accepts aXb', () => {
    expect(kernelAccepts('//p/a[!e]b', 'subset', '/p/ae\u0301b')).toBe(false);
    expect(kernelAccepts('//p/a[!e]b', 'subset', '/p/aXb')).toBe(true);
  });

  it('the subset form of [!a]b rejects àb in its decomposed bytes and accepts Xb', () => {
    expect(kernelAccepts('//p/[!a]b', 'subset', '/p/a\u0300b')).toBe(false);
    expect(kernelAccepts('//p/[!a]b', 'subset', '/p/Xb')).toBe(true);
  });

  it('the deny form of a[à-ÿ]b accepts aéb in its decomposed bytes and aæb, and rejects the ASCII name aeb', () => {
    expect(kernelAccepts('//p/a[à-ÿ]b', 'deny', '/p/ae\u0301b')).toBe(true);
    expect(kernelAccepts('//p/a[à-ÿ]b', 'deny', '/p/a\u00e6b')).toBe(true);
    expect(kernelAccepts('//p/a[à-ÿ]b', 'deny', '/p/aeb')).toBe(false);
  });

  it('the deny form of a class whose complement holds no ASCII contains no literal undefined and stays a superset', () => {
    const pattern = onlyPattern('//p/a[!\u0001-\u007f]b');
    expect(regexSource(fileMatcherOf(pattern, '/p', 'deny').own)).not.toContain('undefined');
    expect(regexSource(fileMatcherOf(pattern, '/p', 'deny').below)).not.toContain('undefined');
    expect(kernelAccepts('//p/a[!\u0001-\u007f]b', 'deny', '/p/ae\u0301b')).toBe(true);
    expect(kernelAccepts('//p/a[!\u0001-\u007f]b', 'deny', '/p/aあb')).toBe(true);
    expect(kernelAccepts('//p/a[!\u0001-\u007f]b', 'deny', '/p/aXb')).toBe(false);
  });
});

describe('checkFilePatternGrammar', () => {
  it.each([
    ['a[b', 'unterminated_class'],
    ['[z-a]', 'reversed_range'],
    ['[[:foo:]]x', 'posix_class'],
    ['a\\', 'escape'],
    ['a/*/../b', 'parent_after_wildcard'],
    ['~root/.ssh/**', 'user_home'],
    ['~root', 'user_home'],
  ])('rejects %s with reason %s', (specifier, reason) => {
    let thrown: unknown;
    try {
      checkFilePatternGrammar(specifier);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FileRuleError);
    expect((thrown as FileRuleError).code).toBe('unsupported_pattern');
    expect((thrown as FileRuleError).reason).toBe(reason);
  });

  it.each(['../a/*.ts', 'a[b]', '[]a]', '{a,b}', '\\*', '**/x/**', '~/notes/**', '//abs/**', '!sample.env'])('accepts %s', (specifier) => {
    expect(() => checkFilePatternGrammar(specifier)).not.toThrow();
  });
});
