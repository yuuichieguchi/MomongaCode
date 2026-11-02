import { describe, expect, it } from 'vitest';
import { fileRuleBlocks, protectedSetFor } from '@momonga/foundation';
import type { PolicyFilesystem } from '@momonga/policy';
import type { Witness } from '../src/decision-model.ts';
import { buildQueryContext } from '../src/verify.ts';
import { UnsupportedRegexError, parseRegexSource } from '../src/regex-source.ts';
import { caseInsensitiveFs, caseSensitiveFs, makeLayout, rulesOf, sshLocation, useZ3 } from './harness.ts';
import type { Layout } from './harness.ts';

const z3 = useZ3();

const SPECIFIERS: readonly string[] = [
  './a/**',
  './a/b.txt',
  './a',
  './*.md',
  './a/*.txt',
  './a/**/d.md',
  '**/*.pem',
  '*.pem',
  'a',
  './[a-b]/?.txt',
  './[!a]/*',
  './[^a-c]x',
  './a/[b\\]]c',
  './a?/**',
  './a*b',
  './**',
  '~/h/**',
  '~/.ssh',
  '//tmp/**',
  './é/**',
  './a[+-0]b',
];

const candidatesOf = (layout: Layout): string[] => {
  const project = layout.project;
  const names = ['a', 'a/b.txt', 'a/b.pem', 'a/c/d.md', 'a/c/e/d.md', 'ab', 'axb', 'a/x.txt', 'b/x.txt', 'b/y', 'c', 'notes.md', 'key.pem', 'x/key.pem', 'A/B.TXT', 'Key.PEM', '.git/config', 'é/f', 'é', 'bx', 'dx', 'a]c', 'a/]c', 'a/b]c', 'a1/z', 'ab/z', 'a.b', 'a-b', 'a0b', 'a/b'];
  return [
    ...names.map((name) => `${project}/${name}`),
    project,
    `${layout.home}/h/f`,
    `${layout.home}/h`,
    `${layout.home}/.ssh`,
    `${layout.home}/.ssh/id`,
    `${layout.home}/.SSH/id`,
    `${layout.outside}/z`,
    '/tmp/x',
    '/private/tmp/x',
    '/',
  ];
};

const modelMatches = async (layout: Layout, specifier: string, fileSystem: PolicyFilesystem, exceptions: readonly string[]): Promise<{ disagreements: string[]; compared: number }> => {
  const [base] = rulesOf(layout, [['deny', `Read(${specifier})`]], 'user');
  const rule = { ...(base as NonNullable<typeof base>), ...(exceptions.length > 0 ? { exceptions } : {}) };
  const roots = [layout.project];
  const context = buildQueryContext(z3.engine().api, {
    rules: [rule],
    roots,
    mode: 'default',
    home: layout.home,
    cwd: layout.project,
    protectedSet: protectedSetFor(roots, fileSystem),
    fs: fileSystem,
    secretLocations: [sshLocation(layout)],
    exemptDirectory: null,
    budgetMs: 30_000,
  });
  const subject = context.subjects.get('Read');
  const term = subject?.terms[0];
  if (subject === undefined || term === undefined) throw new Error('the rule has no subject');
  const disagreements: string[] = [];
  let compared = 0;
  for (const candidate of candidatesOf(layout)) {
    const witness: Witness = { kind: 'path', tool: 'Read', access: 'read', requested: candidate, resolved: candidate };
    const result = await context.models.smt.solve([...subject.domain, ...subject.bind(witness)], 30_000);
    if (result.status !== 'sat') continue;
    const expected = context.env.fileRules.entries.filter((entry) => entry.ruleIndex === 0).some((entry) => fileRuleBlocks(context.env.fileRules, entry, candidate, candidate));
    compared += 1;
    if (result.readBool(term.position) !== expected) disagreements.push(`${specifier} on ${candidate}: product ${expected}`);
  }
  return { disagreements, compared };
};

describe('file patterns encode the regular language the product matches', () => {
  it.each([
    ['case sensitive volume', caseSensitiveFs],
    ['case insensitive volume', caseInsensitiveFs],
  ] as const)('agrees with the compiled matchers on every specifier and path, %s', async (_label, makeFs) => {
    const layout = makeLayout();
    const failures: string[] = [];
    let compared = 0;
    for (const specifier of SPECIFIERS) {
      const result = await modelMatches(layout, specifier, makeFs(), []);
      failures.push(...result.disagreements);
      compared += result.compared;
    }
    expect(failures).toEqual([]);
    expect(compared).toBeGreaterThan(SPECIFIERS.length * 20);
  }, 300_000);

  it('agrees on rules with exceptions carved out of a broader pattern', async () => {
    const layout = makeLayout();
    const failures: string[] = [];
    for (const [specifier, exceptions] of [
      ['./**', ['./a/keep/**']],
      ['./a/**', ['./a/b.txt', './a/c/**']],
      ['./**/*.pem', ['./x/**']],
    ] as const) {
      failures.push(...(await modelMatches(layout, specifier, caseInsensitiveFs(), exceptions)).disagreements);
    }
    expect(failures).toEqual([]);
  }, 300_000);
});

describe('the regular expression subset', () => {
  const dialect = { alphabet: [[0x20, 0x7e]] as [number, number][], ignoreCase: false };

  it('rejects a construct the product does not generate rather than guessing its meaning', () => {
    for (const source of ['a*', '^a', '^a{2}$', '^(?:a)$', '^a(?=b)$', '^\\d$', '^a**$']) {
      expect(() => parseRegexSource(source, dialect), source).toThrow(UnsupportedRegexError);
    }
  });
});
