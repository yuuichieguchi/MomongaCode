import { describe, expect, it } from 'vitest';
import { resolveGoverning } from '@momonga/memory';
import type { GoverningFactView } from '@momonga/protocol';

const PROJECT = '/work/a';
const NOW = 1000;

const fact = (id: string, overrides: Partial<GoverningFactView> = {}): GoverningFactView => ({
  id,
  kind: 'constraint',
  target: 'pandas',
  text: `text of ${id}`,
  scope: { level: 'project', project: PROJECT, paths: [] },
  validFrom: 1,
  validUntil: null,
  retiredAt: null,
  supersedes: [],
  enforcement: null,
  source: { kind: 'command', at: 1 },
  ...overrides,
});

const resolve = (facts: GoverningFactView[], touchedPaths: string[] = [], extra: { ignorePaths?: boolean } = {}) =>
  resolveGoverning(facts, { now: NOW, project: PROJECT, touchedPaths, ...extra });

const activeIds = (facts: GoverningFactView[], touchedPaths: string[] = [], extra: { ignorePaths?: boolean } = {}): string[] =>
  resolve(facts, touchedPaths, extra)
    .active.map((entry) => entry.id)
    .sort();

const chainOf = (depth: number): GoverningFactView[] =>
  Array.from({ length: depth + 1 }, (_, index) => fact(`r${index}`, { validFrom: index + 1, supersedes: index === 0 ? [] : [`r${index - 1}`] }));

describe('scope', () => {
  it('keeps a user fact in every project', () => {
    expect(activeIds([fact('u', { scope: { level: 'user' } })])).toEqual(['u']);
  });

  it('keeps a project fact only in its own project', () => {
    const facts = [fact('here'), fact('there', { scope: { level: 'project', project: '/work/b', paths: [] } })];
    expect(activeIds(facts)).toEqual(['here']);
  });

  it('needs a touched path matching one glob of a path-scoped fact', () => {
    const scoped = fact('p', { scope: { level: 'project', project: PROJECT, paths: ['docs/**', 'src/**'] } });
    expect(activeIds([scoped])).toEqual([]);
    expect(activeIds([scoped], ['/work/a/lib/x.ts'])).toEqual([]);
    expect(activeIds([scoped], ['/work/a/src/deep/x.ts'])).toEqual(['p']);
  });

  it('does not match a touched path of another project against the glob', () => {
    const scoped = fact('p', { scope: { level: 'project', project: PROJECT, paths: ['src/**'] } });
    expect(activeIds([scoped], ['/work/b/src/x.ts'])).toEqual([]);
  });

  it('accepts the working directory as the matching path', () => {
    const scoped = fact('p', { scope: { level: 'project', project: PROJECT, paths: ['legacy/**'] } });
    expect(activeIds([scoped], ['/work/a/legacy/module'])).toEqual(['p']);
  });
});

describe('liveness', () => {
  it.each<[string, Partial<GoverningFactView>, string[]]>([
    ['begins exactly now', { validFrom: NOW }, ['f']],
    ['begins later', { validFrom: NOW + 1 }, []],
    ['ended exactly now', { validUntil: NOW }, []],
    ['ended before', { validUntil: NOW - 1 }, []],
    ['ends later', { validUntil: NOW + 1 }, ['f']],
    ['is retired', { retiredAt: 5 }, []],
  ])('a fact that %s', (_name, overrides, expected) => {
    expect(activeIds([fact('f', overrides)])).toEqual(expected);
  });
});

describe('supersession', () => {
  it('keeps the successor only', () => {
    expect(activeIds([fact('old'), fact('new', { supersedes: ['old'] })])).toEqual(['new']);
  });

  it('does not revive what a retired successor replaced', () => {
    const facts = [fact('old'), fact('new', { supersedes: ['old'], retiredAt: 5 })];
    expect(resolve(facts)).toEqual({ active: [], conflicts: [] });
  });

  it('does not revive what an expired successor replaced', () => {
    const facts = [fact('old'), fact('new', { supersedes: ['old'], validUntil: 5 })];
    expect(activeIds(facts)).toEqual([]);
  });

  it('lets a new fact replace a retired successor', () => {
    const facts = [fact('old'), fact('mid', { supersedes: ['old'], retiredAt: 5 }), fact('next', { supersedes: ['mid'] })];
    expect(activeIds(facts)).toEqual(['next']);
  });

  it.each([1, 2, 4, 8])('keeps only the head of a revision chain of depth %i, with no stale fact and no conflict', (depth) => {
    const { active, conflicts } = resolve(chainOf(depth));
    expect(active.map((entry) => entry.id)).toEqual([`r${depth}`]);
    expect(conflicts).toEqual([]);
  });

  it('keeps nothing of a chain whose head is retired', () => {
    const chain = chainOf(4).map((entry) => (entry.id === 'r4' ? { ...entry, retiredAt: 5 } : entry));
    expect(activeIds(chain)).toEqual([]);
  });

  it('reduces to scope and liveness when nothing is superseded', () => {
    const facts = [fact('a', { target: 'a' }), fact('b', { target: 'b' }), fact('c', { target: 'c', scope: { level: 'user' } })];
    expect(activeIds(facts)).toEqual(['a', 'b', 'c']);
  });
});

describe('concurrent conflict', () => {
  it('keeps both and reports them, however far apart they were issued', () => {
    const facts = [fact('early', { validFrom: 1 }), fact('late', { validFrom: 900 })];
    const { active, conflicts } = resolve(facts);
    expect(active.map((entry) => entry.id).sort()).toEqual(['early', 'late']);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.target).toBe('pandas');
    expect([...(conflicts[0]?.ids ?? [])].sort()).toEqual(['early', 'late']);
  });

  it('reports a fork of one fact as a conflict of its two successors', () => {
    const facts = [fact('root'), fact('left', { supersedes: ['root'] }), fact('right', { supersedes: ['root'] })];
    const { active, conflicts } = resolve(facts);
    expect(active.map((entry) => entry.id).sort()).toEqual(['left', 'right']);
    expect([...(conflicts[0]?.ids ?? [])].sort()).toEqual(['left', 'right']);
  });

  it('gives the same result in any input order', () => {
    const facts = [fact('a', { validFrom: 3 }), fact('b', { validFrom: 2 }), fact('c', { validFrom: 1 })];
    const ids = (input: GoverningFactView[]) => resolve(input).active.map((entry) => entry.id).sort();
    expect(ids(facts)).toEqual(ids([...facts].reverse()));
    expect(ids(facts)).toEqual(['a', 'b', 'c']);
  });

  it('reports no conflict once one side is retired', () => {
    expect(resolve([fact('a'), fact('b', { retiredAt: 5 })]).conflicts).toEqual([]);
  });
});

describe('scopes are separate groups', () => {
  it('a narrower fact does not override a wider one, and both stay without a conflict', () => {
    const wide = fact('wide');
    const narrow = fact('narrow', { validFrom: 500, scope: { level: 'project', project: PROJECT, paths: ['legacy/**'] } });
    const { active, conflicts } = resolve([wide, narrow], ['/work/a/legacy/x.py']);
    expect(active.map((entry) => entry.id).sort()).toEqual(['narrow', 'wide']);
    expect(conflicts).toEqual([]);
  });

  it('a project fact does not override a user fact', () => {
    const { active, conflicts } = resolve([fact('user', { scope: { level: 'user' } }), fact('project', { validFrom: 500 })]);
    expect(active.map((entry) => entry.id).sort()).toEqual(['project', 'user']);
    expect(conflicts).toEqual([]);
  });

  it('treats a target as one group only within one scope key, whatever the order of its paths', () => {
    const first = fact('first', { scope: { level: 'project', project: PROJECT, paths: ['a/**', 'b/**'] } });
    const second = fact('second', { scope: { level: 'project', project: PROJECT, paths: ['b/**', 'a/**'] } });
    expect(resolve([first, second], ['/work/a/a/x']).conflicts).toHaveLength(1);
  });
});

describe('the form for enforcement', () => {
  it('keeps a path-scoped fact with no touched path when paths are ignored', () => {
    const scoped = fact('p', { scope: { level: 'project', project: PROJECT, paths: ['src/**'] } });
    expect(activeIds([scoped], [], { ignorePaths: true })).toEqual(['p']);
  });

  it('still applies project, liveness and supersession', () => {
    const facts = [
      fact('other', { scope: { level: 'project', project: '/work/b', paths: ['src/**'] } }),
      fact('retired', { target: 'x', retiredAt: 5 }),
      fact('old', { target: 'y', scope: { level: 'project', project: PROJECT, paths: ['src/**'] } }),
      fact('new', { target: 'y', supersedes: ['old'], scope: { level: 'project', project: PROJECT, paths: ['src/**'] } }),
    ];
    expect(activeIds(facts, [], { ignorePaths: true })).toEqual(['new']);
  });
});
