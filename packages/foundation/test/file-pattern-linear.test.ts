import { Worker } from 'node:worker_threads';
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

const WORKER_BOUND_MS = 10_000;

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
import(workerData.module).then(({ fileMatcherOf, parseFilePattern, testFileMatcher }) => {
  const context = { roots: ['/w'], home: '/h', settingsRoot: '/s', effect: 'deny' };
  const blocks = parseFilePattern(workerData.rule, context).some((pattern) =>
    ['exact', 'deny', 'subset'].some((form) => {
      const verdict = testFileMatcher(fileMatcherOf(pattern, pattern.directory, form), workerData.candidate, false);
      return verdict.own || verdict.below;
    }),
  );
  parentPort.postMessage(blocks);
});
`;

type BoundedAnswer = { kind: 'answered'; blocks: boolean } | { kind: 'ended at the bound' };

const boundedAnswer = (rule: string, candidate: string): Promise<BoundedAnswer> =>
  new Promise((resolve, reject) => {
    const module = new URL('../src/file-pattern.ts', import.meta.url).href;
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { module, rule, candidate } });
    const bound = setTimeout(() => {
      void worker.terminate();
      resolve({ kind: 'ended at the bound' });
    }, WORKER_BOUND_MS);
    worker.once('message', (blocks: boolean) => {
      clearTimeout(bound);
      void worker.terminate();
      resolve({ kind: 'answered', blocks });
    });
    worker.once('error', (error) => {
      clearTimeout(bound);
      reject(error);
    });
  });

describe('file rules are matched over path segments without a backtracking regular expression', () => {
  it.each([
    [`//w/${'*a'.repeat(30)}b`, `/w/${'a'.repeat(20_000)}`],
    [`//w/${'**/a/'.repeat(12)}b`, `/w/${'a/'.repeat(400)}c`],
  ])('answers the pathological rule %# in a worker that is ended when it passes its bound', async (rule, candidate) => {
    const answer = await boundedAnswer(rule, candidate);
    expect(answer).toEqual({ kind: 'answered', blocks: false });
    expect(accepts(rule, `${candidate.slice(0, -1)}b`)).toBe(true);
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
