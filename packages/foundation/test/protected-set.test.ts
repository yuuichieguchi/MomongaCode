import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILE_RULES,
  EMPTY_PROTECTED_SET,
  MAX_POINTER_FILE_BYTES,
  MAX_SYMLINK_HOPS,
  defaultProtectedPaths,
  fileRuleBlocks,
  isProtectedWrite,
  protectedSetFor,
  walkPath,
} from '@momonga/foundation';
import type { EntryRead, PathResolution, ProtectedSet, ProtectedSetPorts, StepRead, Unresolved, UnresolvableErrno, WalkEntry } from '@momonga/foundation';

const ROOT = '/w/proj';
const MAIN_GIT = '/w/main/.git';
const NON_GIT_DEFAULTS = ['.momonga', '.mcp.json', '.envrc', '.vscode', '.idea'].map((name) => path.join(ROOT, name));

const unresolved = (code: UnresolvableErrno): Unresolved => ({ unresolvable: { kind: 'errno', code } });
const directory = (canonical: string): EntryRead => ({ kind: 'directory', canonical });
const file = (text: string): EntryRead => ({ kind: 'file', text });

type FakeTree = {
  entries?: Readonly<Record<string, EntryRead | Error>>;
  noFollow?: Readonly<Record<string, StepRead>>;
  unresolvableBelow?: Readonly<Record<string, UnresolvableErrno>>;
  caseInsensitive?: boolean;
};

const ancestorsOf = (target: string): string[] => {
  const found: string[] = [];
  for (let current = target; current !== path.dirname(current); current = path.dirname(current)) found.push(current);
  return found;
};

const portsOf = (tree: FakeTree, roots: readonly string[] = [ROOT]): ProtectedSetPorts => {
  const rootAncestry = new Set(roots.flatMap(ancestorsOf));
  const canonicalise = (absolute: string): PathResolution => {
    for (const [prefix, code] of Object.entries(tree.unresolvableBelow ?? {})) {
      if (absolute === prefix || absolute.startsWith(`${prefix}/`)) return { ok: false, reason: { kind: 'errno', code } };
    }
    return { ok: true, path: absolute };
  };
  return {
    readEntry: (absolute) => {
      const entry = tree.entries?.[absolute];
      if (entry instanceof Error) throw entry;
      return entry ?? { kind: 'absent' };
    },
    readNoFollow: (absolute): StepRead => tree.noFollow?.[absolute] ?? (rootAncestry.has(absolute) ? { kind: 'directory' } : { kind: 'missing' }),
    canonicalise,
    volumeProbe: () => tree.caseInsensitive ?? false,
  };
};

const probesOf = (tree: FakeTree) => {
  const ports = portsOf(tree);
  return { canonicalise: ports.canonicalise, volumeProbe: ports.volumeProbe };
};

const sorted = (values: readonly string[]): string[] => [...values].sort();

const gitPaths = (set: ProtectedSet): string[] => sorted(set.paths.filter((entry) => !NON_GIT_DEFAULTS.includes(entry)));

const patternBlocks = (set: ProtectedSet, target: string): boolean => set.patterns.entries.some((entry) => fileRuleBlocks(set.patterns, entry, target, target));

const WORKTREE_GIT_DIR = `${MAIN_GIT}/worktrees/wt`;

const worktreeTree = (commondirText = '../..\n'): FakeTree => ({
  entries: {
    [`${ROOT}/.git`]: file(`gitdir: ${WORKTREE_GIT_DIR}\n`),
    [WORKTREE_GIT_DIR]: directory(WORKTREE_GIT_DIR),
    [`${WORKTREE_GIT_DIR}/commondir`]: file(commondirText),
    [MAIN_GIT]: directory(MAIN_GIT),
  },
});

describe('defaultProtectedPaths (moved from sandbox)', () => {
  it('lists the git hooks and config and the workspace control files of a root', () => {
    expect(defaultProtectedPaths(ROOT)).toEqual([
      `${ROOT}/.git/hooks`,
      `${ROOT}/.git/config`,
      `${ROOT}/.momonga`,
      `${ROOT}/.mcp.json`,
      `${ROOT}/.envrc`,
      `${ROOT}/.vscode`,
      `${ROOT}/.idea`,
    ]);
  });
});

describe('EMPTY_PROTECTED_SET', () => {
  it('holds nothing and the empty file-rule set', () => {
    expect(EMPTY_PROTECTED_SET).toEqual({ roots: [], paths: [], lexicalPaths: [], literals: [], names: [], patterns: EMPTY_FILE_RULES, issues: [] });
  });
});

describe('protectedSetFor with a .git directory or no .git', () => {
  const expectedDefault = (): string[] => sorted([...defaultProtectedPaths(ROOT), `${ROOT}/.git/config.worktree`, `${ROOT}/.git/commondir`]);

  it('gives the default list plus config.worktree and commondir when .git is absent', () => {
    const set = protectedSetFor([ROOT], portsOf({}));
    expect(sorted(set.paths)).toEqual(expectedDefault());
    expect(set.roots).toEqual([ROOT]);
    expect(set.names).toEqual(['.git']);
    expect(set.lexicalPaths).toEqual([]);
    expect(set.literals).toEqual([]);
    expect(set.issues).toEqual([]);
  });

  it('gives the same list when .git is a directory', () => {
    const set = protectedSetFor([ROOT], portsOf({ entries: { [`${ROOT}/.git`]: directory(`${ROOT}/.git`) } }));
    expect(sorted(set.paths)).toEqual(expectedDefault());
    expect(set.issues).toEqual([]);
  });

  it('uses the resolved directory when .git is a symlink to a directory', () => {
    const elsewhere = '/w/elsewhere/gitdir';
    const set = protectedSetFor([ROOT], portsOf({ entries: { [`${ROOT}/.git`]: directory(elsewhere) } }));
    expect(set.paths).toEqual(expect.arrayContaining([`${elsewhere}/hooks`, `${elsewhere}/config`, `${elsewhere}/config.worktree`, `${elsewhere}/commondir`]));
    expect(patternBlocks(set, `${elsewhere}/modules/a/hooks`)).toBe(true);
    expect(set.issues).toEqual([]);
  });
});

describe('protectedSetFor with a .git file', () => {
  it('protects the common hooks and config of a linked worktree and not the worktree hooks', () => {
    const set = protectedSetFor([ROOT], portsOf(worktreeTree()));
    expect(gitPaths(set)).toEqual(
      sorted([
        `${ROOT}/.git`,
        `${MAIN_GIT}/hooks`,
        `${MAIN_GIT}/config`,
        `${WORKTREE_GIT_DIR}/config.worktree`,
        `${WORKTREE_GIT_DIR}/commondir`,
        `${WORKTREE_GIT_DIR}/gitdir`,
      ]),
    );
    expect(set.paths).toEqual(expect.arrayContaining(NON_GIT_DEFAULTS));
    expect(set.paths).not.toContain(`${WORKTREE_GIT_DIR}/hooks`);
    expect(set.issues).toEqual([]);
  });

  it('protects the paths inside the resolved git directory of a submodule', () => {
    const root = '/w/main/subm';
    const gitDir = '/w/main/.git/modules/subm';
    const set = protectedSetFor(
      [root],
      portsOf({ entries: { [`${root}/.git`]: file('gitdir: ../.git/modules/subm\n'), [gitDir]: directory(gitDir) } }, [root]),
    );
    expect(set.paths).toEqual(
      expect.arrayContaining([`${root}/.git`, `${gitDir}/hooks`, `${gitDir}/config`, `${gitDir}/config.worktree`, `${gitDir}/commondir`, `${gitDir}/gitdir`]),
    );
    expect(set.paths).not.toContain(`${root}/.git/hooks`);
    expect(set.issues).toEqual([]);
  });

  it('follows an absolute commondir', () => {
    const set = protectedSetFor([ROOT], portsOf(worktreeTree(`${MAIN_GIT}\n`)));
    expect(set.paths).toEqual(expect.arrayContaining([`${MAIN_GIT}/hooks`, `${MAIN_GIT}/config`]));
    expect(set.issues).toEqual([]);
  });

  it('resolves a relative commondir against the git directory', () => {
    const set = protectedSetFor([ROOT], portsOf(worktreeTree('../../\n')));
    expect(set.paths).toEqual(expect.arrayContaining([`${MAIN_GIT}/hooks`, `${MAIN_GIT}/config`]));
    expect(set.issues).toEqual([]);
  });
});

describe('pointer parse rule', () => {
  const pointerTree = (text: string, target = '/w/g'): FakeTree => ({ entries: { [`${ROOT}/.git`]: file(text), [target]: directory(target) } });

  it.each([
    ['no trailing newline', 'gitdir: /w/g'],
    ['LF', 'gitdir: /w/g\n'],
    ['CRLF', 'gitdir: /w/g\r\n'],
  ])('follows a .git file with %s', (_label, text) => {
    const set = protectedSetFor([ROOT], portsOf(pointerTree(text)));
    expect(set.paths).toEqual(expect.arrayContaining(['/w/g/hooks', '/w/g/config']));
    expect(set.issues).toEqual([]);
  });

  it.each([
    ['trailing spaces', 'gitdir: /w/g  \n', '/w/g  '],
    ['a second line', 'gitdir: /w/g\nsecond\n', '/w/g\nsecond'],
  ])('keeps the extra bytes of a .git file with %s, so the chain ends in missing-target', (_label, text, kept) => {
    const set = protectedSetFor([ROOT], portsOf(pointerTree(text)));
    expect(set.issues).toEqual([{ root: ROOT, file: `${ROOT}/.git`, problem: 'missing-target' }]);
    expect(set.paths).toEqual(expect.arrayContaining([`${ROOT}/.git`, kept]));
    expect(set.paths).not.toContain('/w/g/hooks');
  });

  it.each([
    ['no trailing newline', '../..'],
    ['LF', '../..\n'],
    ['CRLF', '../..\r\n'],
  ])('follows a commondir file with %s', (_label, text) => {
    const set = protectedSetFor([ROOT], portsOf(worktreeTree(text)));
    expect(set.paths).toEqual(expect.arrayContaining([`${MAIN_GIT}/hooks`, `${MAIN_GIT}/config`]));
    expect(set.issues).toEqual([]);
  });

  it.each([
    ['trailing spaces', '../..  \n', `${MAIN_GIT}/worktrees/..  `],
    ['a second line', '../..\nsecond\n', `${MAIN_GIT}/worktrees/..\nsecond`],
  ])('keeps the extra bytes of a commondir file with %s, so the chain ends in missing-target', (_label, text, commonDir) => {
    const set = protectedSetFor([ROOT], portsOf(worktreeTree(text)));
    expect(set.issues).toEqual([{ root: ROOT, file: `${WORKTREE_GIT_DIR}/commondir`, problem: 'missing-target' }]);
    expect(set.paths).toContain(commonDir);
    expect(set.paths).not.toContain(`${MAIN_GIT}/hooks`);
  });
});

describe('pointer issues', () => {
  it.each([
    ['a file without the prefix', 'not a pointer\n'],
    ['an empty file', ''],
    ['an empty path', 'gitdir: \n'],
  ])('reports %s as malformed and protects only the pointer file', (_label, text) => {
    const set = protectedSetFor([ROOT], portsOf({ entries: { [`${ROOT}/.git`]: file(text) } }));
    expect(set.issues).toEqual([{ root: ROOT, file: `${ROOT}/.git`, problem: 'malformed' }]);
    expect(gitPaths(set)).toEqual([`${ROOT}/.git`]);
    expect(set.lexicalPaths).toEqual([]);
    expect(set.literals).toEqual([]);
  });

  it('derives MAX_POINTER_FILE_BYTES from PATH_MAX: gitdir prefix, 1023 bytes of path and CRLF', () => {
    expect(MAX_POINTER_FILE_BYTES).toBe('gitdir: '.length + 1023 + '\r\n'.length);
  });

  it('reports an oversize pointer file and protects only the pointer file', () => {
    const set = protectedSetFor([ROOT], portsOf({ entries: { [`${ROOT}/.git`]: { kind: 'oversize' } } }));
    expect(set.issues).toEqual([{ root: ROOT, file: `${ROOT}/.git`, problem: 'oversize' }]);
    expect(gitPaths(set)).toEqual([`${ROOT}/.git`]);
  });

  it.each(['EACCES', 'ELOOP'] as const)('reports %s on the .git file as unresolvable with the reason', (code) => {
    const set = protectedSetFor([ROOT], portsOf({ entries: { [`${ROOT}/.git`]: unresolved(code) } }));
    expect(set.issues).toEqual([{ root: ROOT, file: `${ROOT}/.git`, problem: 'unresolvable', reason: { kind: 'errno', code } }]);
    expect(isProtectedWrite(set, `${ROOT}/.git`, probesOf({}))).toBe(true);
  });

  it.each(['EACCES', 'ELOOP'] as const)('reports %s on the git directory as unresolvable with the reason', (code) => {
    const tree: FakeTree = { entries: { [`${ROOT}/.git`]: file(`gitdir: ${WORKTREE_GIT_DIR}\n`), [WORKTREE_GIT_DIR]: unresolved(code) } };
    const set = protectedSetFor([ROOT], portsOf(tree));
    expect(set.issues).toEqual([{ root: ROOT, file: `${ROOT}/.git`, problem: 'unresolvable', reason: { kind: 'errno', code } }]);
    expect(set.paths).toContain(`${ROOT}/.git`);
  });

  it.each(['EACCES', 'ELOOP'] as const)('reports %s on the commondir file as unresolvable and protects the git directory as a subtree', (code) => {
    const tree = worktreeTree();
    const set = protectedSetFor([ROOT], portsOf({ entries: { ...tree.entries, [`${WORKTREE_GIT_DIR}/commondir`]: unresolved(code) } }));
    expect(set.issues).toEqual([{ root: ROOT, file: `${WORKTREE_GIT_DIR}/commondir`, problem: 'unresolvable', reason: { kind: 'errno', code } }]);
    expect(set.paths).toContain(WORKTREE_GIT_DIR);
    expect(isProtectedWrite(set, `${WORKTREE_GIT_DIR}/hooks/pre-commit`, probesOf({}))).toBe(true);
  });

  it('rethrows EIO from a read unchanged', () => {
    const eio = Object.assign(new Error('EIO: injected'), { code: 'EIO', syscall: 'read', path: `${ROOT}/.git` });
    let caught: unknown;
    try {
      protectedSetFor([ROOT], portsOf({ entries: { [`${ROOT}/.git`]: eio } }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(eio);
  });
});

describe('missing-target', () => {
  it('protects a missing git directory as a subtree with the pointer file', () => {
    const set = protectedSetFor([ROOT], portsOf({ entries: { [`${ROOT}/.git`]: file('gitdir: inner\n') } }));
    const probes = probesOf({});
    expect(set.issues).toEqual([{ root: ROOT, file: `${ROOT}/.git`, problem: 'missing-target' }]);
    expect(set.paths).toEqual(expect.arrayContaining([`${ROOT}/.git`, `${ROOT}/inner`]));
    for (const target of [`${ROOT}/inner`, `${ROOT}/inner/config`, `${ROOT}/inner/x/y`, `${ROOT}/.git`]) {
      expect(isProtectedWrite(set, target, probes)).toBe(true);
    }
    expect(isProtectedWrite(set, `${ROOT}/innerx/config`, probes)).toBe(false);
  });

  it('protects a missing common directory as a subtree', () => {
    const missing = '/w/nope/.git';
    const set = protectedSetFor([ROOT], portsOf(worktreeTree(`${missing}\n`)));
    expect(set.issues).toEqual([{ root: ROOT, file: `${WORKTREE_GIT_DIR}/commondir`, problem: 'missing-target' }]);
    expect(set.paths).toContain(missing);
    expect(isProtectedWrite(set, `${missing}/hooks/pre-commit`, probesOf({}))).toBe(true);
  });
});

describe('case (ii): the parsed target does not canonicalise', () => {
  const pointedTo = (text: string, tree: FakeTree): ProtectedSet =>
    protectedSetFor([ROOT], portsOf({ ...tree, entries: { [`${ROOT}/.git`]: file(text), ...tree.entries } }));

  const literalSet = (set: ProtectedSet): Set<string> => new Set(set.literals);

  it('protects the lexical target for approval, pins a regular file in the path and reports unresolvable', () => {
    const set = pointedTo('gitdir: x/y\n', { noFollow: { [`${ROOT}/x`]: { kind: 'other' } }, unresolvableBelow: { [`${ROOT}/x`]: 'ENOTDIR' } });
    const probes = probesOf({ unresolvableBelow: { [`${ROOT}/x`]: 'ENOTDIR' } });
    expect(set.lexicalPaths).toContain(`${ROOT}/x/y`);
    expect(set.paths).not.toContain(`${ROOT}/x/y`);
    expect(literalSet(set)).toEqual(new Set([`${ROOT}/x`]));
    expect(set.issues).toEqual([{ root: ROOT, file: `${ROOT}/.git`, problem: 'unresolvable', reason: { kind: 'errno', code: 'ENOTDIR' } }]);
    expect(isProtectedWrite(set, `${ROOT}/x/y`, probes)).toBe(true);
    expect(isProtectedWrite(set, `${ROOT}/x/y/config`, probes)).toBe(true);
    expect(isProtectedWrite(set, `${ROOT}/x`, probes)).toBe(true);
  });

  it('pins a one-link loop', () => {
    const set = pointedTo('gitdir: x/y\n', { noFollow: { [`${ROOT}/x`]: { kind: 'symlink', target: 'x' } }, unresolvableBelow: { [`${ROOT}/x`]: 'ELOOP' } });
    expect(literalSet(set)).toEqual(new Set([`${ROOT}/x`]));
    expect(set.issues[0]).toMatchObject({ root: ROOT, problem: 'unresolvable' });
  });

  it('pins both links of a two-link loop', () => {
    const set = pointedTo('gitdir: a/y\n', {
      noFollow: { [`${ROOT}/a`]: { kind: 'symlink', target: 'b' }, [`${ROOT}/b`]: { kind: 'symlink', target: 'a' } },
      unresolvableBelow: { [`${ROOT}/a`]: 'ELOOP' },
    });
    expect(literalSet(set)).toEqual(new Set([`${ROOT}/a`, `${ROOT}/b`]));
  });

  it('pins the link and the regular file it points to', () => {
    const set = pointedTo('gitdir: sf/y\n', {
      noFollow: { [`${ROOT}/sf`]: { kind: 'symlink', target: 'f' }, [`${ROOT}/f`]: { kind: 'other' } },
      unresolvableBelow: { [`${ROOT}/sf`]: 'ENOTDIR' },
    });
    expect(literalSet(set)).toEqual(new Set([`${ROOT}/sf`, `${ROOT}/f`]));
    const probes = probesOf({});
    expect(isProtectedWrite(set, `${ROOT}/sf`, probes)).toBe(true);
    expect(isProtectedWrite(set, `${ROOT}/f`, probes)).toBe(true);
  });

  it('pins the link and the directory without search permission', () => {
    const set = pointedTo('gitdir: a/l/y\n', {
      noFollow: {
        [`${ROOT}/a`]: { kind: 'directory' },
        [`${ROOT}/a/l`]: { kind: 'symlink', target: '../locked/z' },
        [`${ROOT}/locked`]: { kind: 'directory' },
        [`${ROOT}/locked/z`]: unresolved('EACCES'),
      },
      unresolvableBelow: { [`${ROOT}/a/l`]: 'EACCES' },
    });
    expect(literalSet(set)).toEqual(new Set([`${ROOT}/a/l`, `${ROOT}/locked`]));
  });

  it('pins every link visited of a loop longer than the hop bound', () => {
    expect(MAX_SYMLINK_HOPS).toBe(40);
    const count = MAX_SYMLINK_HOPS + 5;
    const link = (index: number): string => `${ROOT}/l${index % count}`;
    const noFollow: Record<string, StepRead> = {};
    for (let index = 0; index < count; index += 1) noFollow[link(index)] = { kind: 'symlink', target: path.basename(link(index + 1)) };
    const set = pointedTo('gitdir: l0/y\n', { noFollow, unresolvableBelow: { [`${ROOT}/l0`]: 'ELOOP' } });
    const visited = Array.from({ length: MAX_SYMLINK_HOPS + 1 }, (_unused, index) => link(index));
    expect(literalSet(set)).toEqual(new Set(visited));
  });

  it('pins nothing for an over-long component', () => {
    const long = 'n'.repeat(300);
    const set = pointedTo(`gitdir: ${long}/y\n`, { noFollow: { [`${ROOT}/${long}`]: unresolved('ENAMETOOLONG') }, unresolvableBelow: { [`${ROOT}/${long}`]: 'ENAMETOOLONG' } });
    expect(set.literals).toEqual([]);
    expect(set.lexicalPaths).toContain(`${ROOT}/${long}/y`);
  });

  it('skips an entry outside every root', () => {
    const set = pointedTo('gitdir: sf/y\n', {
      noFollow: { [`${ROOT}/sf`]: { kind: 'symlink', target: '/w/elsewhere/f' }, '/w/elsewhere': { kind: 'directory' }, '/w/elsewhere/f': { kind: 'other' } },
      unresolvableBelow: { [`${ROOT}/sf`]: 'ENOTDIR' },
    });
    expect(literalSet(set)).toEqual(new Set([`${ROOT}/sf`]));
  });

  it('writes each entry as written and with only its parent canonicalised', () => {
    const tree: FakeTree = {
      entries: { [`${ROOT}/.git`]: file('gitdir: x/y\n') },
      noFollow: { [`${ROOT}/x`]: { kind: 'other' } },
      unresolvableBelow: { [`${ROOT}/x`]: 'ENOTDIR' },
    };
    const base = portsOf(tree);
    const ports: ProtectedSetPorts = {
      ...base,
      canonicalise: (absolute) => (absolute === ROOT ? { ok: true, path: `/private${ROOT}` } : base.canonicalise(absolute)),
    };
    const set = protectedSetFor([ROOT], ports);
    expect(literalSet(set)).toEqual(new Set([`${ROOT}/x`, `/private${ROOT}/x`]));
  });
});

describe('walkPath failure reports', () => {
  const stepOf =
    (entries: Readonly<Record<string, WalkEntry | Unresolved>>) =>
    (absolute: string): WalkEntry | { stepFailure: Unresolved } => {
      const entry = entries[absolute] ?? (ancestorsOf(ROOT).includes(absolute) ? { kind: 'directory' } : { kind: 'missing' });
      return 'unresolvable' in entry ? { stepFailure: entry } : entry;
    };

  it('reports ENOTDIR with the file as candidate and its parent as prefix', () => {
    const links: string[] = [];
    const result = walkPath(`${ROOT}/x/y`, stepOf({ [`${ROOT}/x`]: { kind: 'other' } }), (name) => links.push(name));
    expect(result).toEqual({ ok: false, failure: { reason: { kind: 'errno', code: 'ENOTDIR' }, candidate: `${ROOT}/x`, prefix: ROOT } });
    expect(links).toEqual([]);
  });

  it('reports a step failure with the candidate and the current prefix', () => {
    const links: string[] = [];
    const result = walkPath(
      `${ROOT}/a/l/y`,
      stepOf({
        [`${ROOT}/a`]: { kind: 'directory' },
        [`${ROOT}/a/l`]: { kind: 'symlink', target: '../locked/z' },
        [`${ROOT}/locked`]: { kind: 'directory' },
        [`${ROOT}/locked/z`]: unresolved('EACCES'),
      }),
      (name) => links.push(name),
    );
    expect(result).toEqual({ ok: false, stepFailure: { unresolvable: { kind: 'errno', code: 'EACCES' } }, candidate: `${ROOT}/locked/z`, prefix: `${ROOT}/locked` });
    expect(links).toEqual([`${ROOT}/a/l`]);
  });

  it('reports ELOOP at the link where the bound ran out and has called onLink for every hop', () => {
    const links: string[] = [];
    const result = walkPath(`${ROOT}/x/y`, stepOf({ [`${ROOT}/x`]: { kind: 'symlink', target: 'x' } }), (name) => links.push(name));
    expect(result).toEqual({ ok: false, failure: { reason: { kind: 'errno', code: 'ELOOP' }, candidate: `${ROOT}/x`, prefix: ROOT } });
    expect(links).toHaveLength(MAX_SYMLINK_HOPS + 1);
    expect(new Set(links)).toEqual(new Set([`${ROOT}/x`]));
  });

  it('reports an over-long name as a step failure', () => {
    const long = `${ROOT}/${'n'.repeat(300)}`;
    const result = walkPath(`${long}/y`, stepOf({ [long]: unresolved('ENAMETOOLONG') }), () => undefined);
    expect(result).toEqual({ ok: false, stepFailure: { unresolvable: { kind: 'errno', code: 'ENAMETOOLONG' } }, candidate: long, prefix: ROOT });
  });

  it('returns the existing prefix and the missing tail', () => {
    const result = walkPath(`${ROOT}/missing/deeper`, stepOf({}), () => undefined);
    expect(result).toEqual({ ok: true, prefix: ROOT, tail: ['missing', 'deeper'] });
  });
});

describe('patterns for the nested git directories', () => {
  const PROVENANCE = { ruleText: 'protected set', layer: 'protected', source: 'momonga' };

  it('protects submodule and worktree hooks and config of a worktree common directory, not their objects or HEAD', () => {
    const set = protectedSetFor([ROOT], portsOf(worktreeTree()));
    for (const target of ['modules/a/hooks', 'modules/a/modules/b/hooks', 'modules/a/config', 'modules/a/config.worktree', 'worktrees/w/config.worktree']) {
      expect(patternBlocks(set, `${MAIN_GIT}/${target}`)).toBe(true);
      expect(isProtectedWrite(set, `${MAIN_GIT}/${target}`, probesOf({}))).toBe(true);
    }
    for (const target of ['modules/a/objects/x', 'worktrees/w/HEAD']) {
      expect(patternBlocks(set, `${MAIN_GIT}/${target}`)).toBe(false);
      expect(isProtectedWrite(set, `${MAIN_GIT}/${target}`, probesOf({}))).toBe(false);
    }
    for (const entry of set.patterns.entries) {
      expect(entry).toMatchObject({ tool: 'Edit', access: 'write', effect: 'deny', provenance: PROVENANCE });
    }
  });

  it('protects the same entries below a standalone repository', () => {
    const set = protectedSetFor([ROOT], portsOf({}));
    const common = `${ROOT}/.git`;
    for (const target of ['modules/a/hooks', 'modules/a/modules/b/hooks', 'modules/a/config', 'modules/a/config.worktree', 'worktrees/w/config.worktree']) {
      expect(patternBlocks(set, `${common}/${target}`)).toBe(true);
    }
    for (const target of ['modules/a/objects/x', 'worktrees/w/HEAD']) {
      expect(patternBlocks(set, `${common}/${target}`)).toBe(false);
    }
  });

  it('matches a common directory with glob characters literally', () => {
    const root = '/w/a[1]*';
    const set = protectedSetFor([root], portsOf({}, [root]));
    expect(patternBlocks(set, `${root}/.git/modules/s/hooks`)).toBe(true);
    expect(patternBlocks(set, '/w/a1x/.git/modules/s/hooks')).toBe(false);
  });

  it('keeps a stable fingerprint', () => {
    const first = protectedSetFor([ROOT], portsOf(worktreeTree()));
    const second = protectedSetFor([ROOT], portsOf(worktreeTree()));
    expect(first.patterns.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(second.patterns.fingerprint).toBe(first.patterns.fingerprint);
  });
});

describe('isProtectedWrite and the .git name', () => {
  const set = (): ProtectedSet => protectedSetFor([ROOT], portsOf({}));

  it('is true for each derived path and for components named .git', () => {
    const probes = probesOf({});
    for (const entry of set().paths) expect(isProtectedWrite(set(), entry, probes)).toBe(true);
    for (const target of [`${ROOT}/.git`, `${ROOT}/.git/objects/ab`, `${ROOT}/sub/.git/config`, `${ROOT}/sub/.git/HEAD`, `${ROOT}/a/b/.git`]) {
      expect(isProtectedWrite(set(), target, probes)).toBe(true);
    }
  });

  it('is false for names that only start or end with .git', () => {
    const probes = probesOf({});
    for (const target of [`${ROOT}/.gitignore`, `${ROOT}/.github/workflows/ci.yml`, `${ROOT}/x.git`, `${ROOT}/src/a.ts`]) {
      expect(isProtectedWrite(set(), target, probes)).toBe(false);
    }
  });

  it('folds the .git component only on a case-insensitive volume', () => {
    expect(isProtectedWrite(set(), `${ROOT}/sub/.GIT/config`, probesOf({ caseInsensitive: true }))).toBe(true);
    expect(isProtectedWrite(set(), `${ROOT}/sub/.GIT/config`, probesOf({ caseInsensitive: false }))).toBe(false);
  });

  it('does not protect a .git below a directory that is not a root', () => {
    expect(isProtectedWrite(set(), '/w/tmp/session/.git/config', probesOf({}))).toBe(false);
  });

  it('compares an unresolvable paths entry lexically', () => {
    const lexicalSet: ProtectedSet = { ...EMPTY_PROTECTED_SET, roots: [ROOT], paths: [`${ROOT}/loop`] };
    const probes = probesOf({ unresolvableBelow: { [`${ROOT}/loop`]: 'ELOOP' } });
    expect(isProtectedWrite(lexicalSet, `${ROOT}/loop/x`, probes)).toBe(true);
    expect(isProtectedWrite(lexicalSet, `${ROOT}/loopy/x`, probes)).toBe(false);
  });
});

describe('Stage D: pinned .git links and anchors', () => {
  it.each([
    ['ELOOP', { kind: 'symlink', target: '.git' }],
    ['EACCES', { kind: 'symlink', target: 'locked/z' }],
  ] as const)('an %s read of root/.git pins the link in literals, not in paths', (code, link) => {
    const set = protectedSetFor(
      [ROOT],
      portsOf({
        entries: { [`${ROOT}/.git`]: unresolved(code) },
        noFollow: { [`${ROOT}/.git`]: link, [`${ROOT}/locked`]: { kind: 'directory' }, [`${ROOT}/locked/z`]: unresolved('EACCES') },
        unresolvableBelow: { [`${ROOT}/.git`]: code },
      }),
    );
    expect(set.paths).not.toContain(`${ROOT}/.git`);
    expect(set.literals).toContain(`${ROOT}/.git`);
    expect(set.issues).toEqual([{ root: ROOT, file: `${ROOT}/.git`, problem: 'unresolvable', reason: { kind: 'errno', code } }]);
  });

  it('pins a symlinked .git directory in literals', () => {
    const set = protectedSetFor([ROOT], portsOf({ entries: { [`${ROOT}/.git`]: directory(`${ROOT}/realgit`) }, noFollow: { [`${ROOT}/.git`]: { kind: 'symlink', target: 'realgit' }, [`${ROOT}/realgit`]: { kind: 'directory' } } }));
    expect(set.literals).toContain(`${ROOT}/.git`);
    expect(set.paths).toContain(`${ROOT}/realgit/hooks`);
  });

  it('reports an unresolvable modules directory once', () => {
    const modules = `${ROOT}/.git/modules`;
    const set = protectedSetFor([ROOT], portsOf({ noFollow: { [`${ROOT}/.git`]: { kind: 'directory' }, [modules]: { kind: 'symlink', target: 'modules' } }, unresolvableBelow: { [modules]: 'ELOOP' } }));
    expect(set.issues).toHaveLength(1);
  });

  it('matches a literal through the canonical parent of a hand-built one-spelling set', () => {
    const set: ProtectedSet = { ...EMPTY_PROTECTED_SET, roots: [ROOT], literals: ['/link/x'] };
    const probes = { canonicalise: (absolute: string): PathResolution => ({ ok: true, path: absolute === '/link' ? ROOT : absolute }), volumeProbe: () => false };
    expect(isProtectedWrite(set, `${ROOT}/x`, probes)).toBe(true);
    expect(isProtectedWrite(set, `${ROOT}/y`, probes)).toBe(false);
  });
});
