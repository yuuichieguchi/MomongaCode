import { describe, expect, it } from 'vitest';
import { verdictKey, verdictSubjectOf } from '../src/rule-fingerprint.ts';

const SOLVER = 'z3 ' + 'a'.repeat(64);
const facts = {
  rules: [{ text: 'Read(.env)', effect: 'deny', source: '/home/u/.momonga/settings.json' }],
  roots: ['/work', '/extra'],
  mode: 'manual',
  home: '/home/u',
  cwd: '/work',
  exemptDirectory: '/home/u/.momonga/tmp/sessions/s1',
  enforcement: 'exact-paths',
  protectedSet: { paths: ['/work/.git'], lexicalPaths: [], literals: [] },
  secretLocations: [{ label: '~/.ssh', directory: '/home/u/.ssh' }],
  deniedLocations: [{ label: '~/.ssh', directory: '/home/u/.ssh' }],
} as const;

describe('the subject of a verdict', () => {
  it('holds the verified facts and nothing of the way they were verified', () => {
    const given = { ...facts, fs: { canonicalise: () => undefined }, budgetMs: 5, signal: new AbortController().signal };
    expect(verdictSubjectOf(given)).toEqual(facts);
  });

  it('names each root once, in the order given', () => {
    expect(verdictSubjectOf({ ...facts, roots: ['/work', '/extra', '/work', '/extra'] }).roots).toEqual(['/work', '/extra']);
  });
});

describe('the key of a verdict', () => {
  const base = verdictSubjectOf(facts);

  it('is a sha256 that is the same for the same subject whatever the order of its fields', () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as typeof base;
    expect(verdictKey(base, SOLVER)).toMatch(/^[0-9a-f]{64}$/);
    expect(verdictKey(reordered, SOLVER)).toBe(verdictKey(base, SOLVER));
  });

  it('is the same for a root list that names a root twice', () => {
    expect(verdictKey(verdictSubjectOf({ ...facts, roots: ['/work', '/extra', '/work'] }), SOLVER)).toBe(verdictKey(base, SOLVER));
  });

  it.each(Object.keys(base).map((field) => [field] as const))('changes when %s changes', (field) => {
    const changed = { ...base, [field]: `${JSON.stringify(base[field as keyof typeof base])} and more` } as never;
    expect(verdictKey(changed, SOLVER)).not.toBe(verdictKey(base, SOLVER));
  });

  it('changes with the scratch folder a session exempts, and when no folder is exempt', () => {
    expect(verdictKey({ ...base, exemptDirectory: '/home/u/.momonga/tmp/sessions/s2' }, SOLVER)).not.toBe(verdictKey(base, SOLVER));
    expect(verdictKey({ ...base, exemptDirectory: null }, SOLVER)).not.toBe(verdictKey(base, SOLVER));
  });

  it('changes when the solver is another one', () => {
    expect(verdictKey(base, 'z3 ' + 'b'.repeat(64))).not.toBe(verdictKey(base, SOLVER));
  });
});
