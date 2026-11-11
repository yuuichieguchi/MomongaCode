import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { protectedSetFor } from '@momonga/foundation';
import type { EntryRead, PathResolution, PlaceholderForm, ProtectedSet, ProtectedSetPorts, StepRead } from '@momonga/foundation';

const ROOT = '/w/proj';
const GIT = path.join(ROOT, '.git');
const MODULE_GIT = '/w/super/.git/modules/proj';

const EMPTY_FILE: PlaceholderForm = { kind: 'file', bytes: '' };
const COMMONDIR_FORM: PlaceholderForm = { kind: 'file', bytes: '.\n' };
const DIRECTORY_FORM: PlaceholderForm = { kind: 'directory' };

const directory = (canonical: string): EntryRead => ({ kind: 'directory', canonical });
const file = (text: string): EntryRead => ({ kind: 'file', text });

const ancestorsOf = (target: string): string[] => {
  const found: string[] = [];
  for (let current = target; current !== path.dirname(current); current = path.dirname(current)) found.push(current);
  return found;
};

const portsOf = (entries: Readonly<Record<string, EntryRead>>, directories: readonly string[] = []): ProtectedSetPorts => {
  const known = new Set([...ancestorsOf(ROOT), ...directories.flatMap(ancestorsOf)]);
  return {
    platform: 'linux',
    readEntry: (absolute) => entries[absolute] ?? { kind: 'absent' },
    readNoFollow: (absolute): StepRead => (known.has(absolute) ? { kind: 'directory' } : { kind: 'missing' }),
    canonicalise: (absolute): PathResolution => ({ ok: true, path: absolute }),
    volumeProbe: () => false,
  };
};

const comparable = (set: ProtectedSet) => ({
  paths: [...set.paths].sort(),
  lexicalPaths: [...set.lexicalPaths].sort(),
  literals: [...set.literals].sort(),
  moduleAnchors: [...set.moduleAnchors].sort(),
  worktreeAnchors: [...set.worktreeAnchors].sort(),
  issues: set.issues,
  forms: set.forms,
});

describe('the absence form of each protected path', () => {
  it('gives a root that is not a repository an empty directory for .git, commondir a dot and a newline, and every other entry an empty file', async () => {
    const set = await protectedSetFor([ROOT], portsOf({}));
    expect(set.forms).toEqual({
      [GIT]: DIRECTORY_FORM,
      [path.join(GIT, 'commondir')]: COMMONDIR_FORM,
      [path.join(GIT, 'hooks')]: EMPTY_FILE,
      [path.join(GIT, 'config')]: EMPTY_FILE,
      [path.join(GIT, 'config.worktree')]: EMPTY_FILE,
      [path.join(ROOT, '.momonga')]: EMPTY_FILE,
      [path.join(ROOT, '.mcp.json')]: EMPTY_FILE,
      [path.join(ROOT, '.envrc')]: EMPTY_FILE,
      [path.join(ROOT, '.vscode')]: EMPTY_FILE,
      [path.join(ROOT, '.idea')]: EMPTY_FILE,
    });
  });

  it('gives the commondir of an existing .git directory a dot and a newline, and its hooks, config and config.worktree an empty file', async () => {
    const set = await protectedSetFor([ROOT], portsOf({ [GIT]: directory(GIT) }, [GIT]));
    expect(set.forms[path.join(GIT, 'commondir')]).toEqual(COMMONDIR_FORM);
    expect(set.forms[path.join(GIT, 'hooks')]).toEqual(EMPTY_FILE);
    expect(set.forms[path.join(GIT, 'config')]).toEqual(EMPTY_FILE);
    expect(set.forms[path.join(GIT, 'config.worktree')]).toEqual(EMPTY_FILE);
    expect(set.forms[path.join(ROOT, '.mcp.json')]).toEqual(EMPTY_FILE);
  });

  it('gives the commondir that the git directory named by a .git file lacks a dot and a newline', async () => {
    const set = await protectedSetFor([ROOT], portsOf({ [GIT]: file(`gitdir: ${MODULE_GIT}\n`), [MODULE_GIT]: directory(MODULE_GIT) }, [MODULE_GIT]));
    expect(set.forms[path.join(MODULE_GIT, 'commondir')]).toEqual(COMMONDIR_FORM);
    expect(set.forms[path.join(MODULE_GIT, 'config.worktree')]).toEqual(EMPTY_FILE);
  });
});

describe('the protected set reads the placeholder forms as git does', () => {
  it('resolves a commondir that holds a dot and a newline to the git directory itself, with no issue', async () => {
    const set = await protectedSetFor(
      [ROOT],
      portsOf({ [GIT]: file(`gitdir: ${MODULE_GIT}\n`), [MODULE_GIT]: directory(MODULE_GIT), [path.join(MODULE_GIT, 'commondir')]: file('.\n') }, [MODULE_GIT]),
    );
    expect(set.issues).toEqual([]);
    expect(set.paths).toEqual(expect.arrayContaining([path.join(MODULE_GIT, 'hooks'), path.join(MODULE_GIT, 'config')]));
    expect(set.moduleAnchors).toEqual([path.join(MODULE_GIT, 'modules')]);
    expect(set.worktreeAnchors).toEqual([path.join(MODULE_GIT, 'worktrees')]);
  });

  it('treats an empty .git directory at a root exactly as an absent .git, its directory form included', async () => {
    const absent = await protectedSetFor([ROOT], portsOf({}));
    const emptyDirectory = await protectedSetFor([ROOT], portsOf({ [GIT]: directory(GIT) }, [GIT]));
    expect(comparable(emptyDirectory)).toEqual(comparable(absent));
    expect(emptyDirectory.forms[GIT]).toEqual(DIRECTORY_FORM);
  });
});
