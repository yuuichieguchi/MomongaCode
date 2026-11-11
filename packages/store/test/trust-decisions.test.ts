import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openRuntimeStore } from '@momonga/store';
import type { RuntimeStore, RuntimeStoreOptions } from '@momonga/store';
import { createFakeClock, NEVER_CANCELLED } from '@momonga/testkit';
import { nodeFileSystem, systemRandom } from '@momonga/foundation';
import { START_MS, exactTrustOf, makeStoreDir, openStoreAt, rawDb, UNASKED_COMMANDS } from './helpers.ts';

type TrustTree = { root: string; home: string; dbPath: string; store: RuntimeStore };

const makeTrustTree = (homeOverride?: (home: string) => string): TrustTree => {
  const root = fs.realpathSync.native(makeStoreDir());
  const home = path.join(root, 'Home');
  fs.mkdirSync(home, { mode: 0o700 });
  const dbPath = path.join(root, 'runtime.db');
  const store = openStoreAt(dbPath, createFakeClock(START_MS), { home: homeOverride === undefined ? home : homeOverride(home) });
  return { root, home, dbPath, store };
};

const mkdir = (dir: string): string => {
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
};

const caseInsensitiveVolume = (): boolean => {
  const probe = mkdir(path.join(fs.realpathSync.native(makeStoreDir()), 'CaseProbe'));
  try {
    return fs.realpathSync.native(probe.toLowerCase()) === probe;
  } catch {
    return false;
  }
};

const CASE_INSENSITIVE = caseInsensitiveVolume();

const openOptions = (dir: string, home: string): RuntimeStoreOptions => ({
  path: path.join(dir, 'runtime.db'),
  home,
  clock: createFakeClock(START_MS),
  leaseMs: 1000,
  maxAttempts: 3,
  maxTotalAttempts: 100,
  unaskedCommands: UNASKED_COMMANDS,
  fileSystem: nodeFileSystem,
  random: systemRandom,
});

describe('openRuntimeStore home', () => {
  it('refuses options without a home', () => {
    const dir = makeStoreDir();
    const { home: _home, ...withoutHome } = openOptions(dir, dir);
    expect(() => openRuntimeStore(withoutHome as unknown as RuntimeStoreOptions)).toThrow();
  });
});

describe('trust.decisionAsked', () => {
  it('returns the exact decision without inheritedFrom', async () => {
    const { root, store } = makeTrustTree();
    const project = mkdir(path.join(root, 'work', 'project'));
    await store.trust.setAsked(project, 'trusted', NEVER_CANCELLED);
    expect(await store.trust.decisionAsked(project, NEVER_CANCELLED)).toEqual({ decision: 'trusted' });
    expect((await store.trust.decisionAsked(project, NEVER_CANCELLED)).inheritedFrom).toBeUndefined();
  });

  it('inherits the nearest ancestor decision and names it', async () => {
    const { root, store } = makeTrustTree();
    const outer = mkdir(path.join(root, 'work'));
    const inner = mkdir(path.join(outer, 'project'));
    const deep = mkdir(path.join(inner, 'src', 'lib'));
    await store.trust.setAsked(outer, 'untrusted', NEVER_CANCELLED);
    await store.trust.setAsked(inner, 'trusted', NEVER_CANCELLED);
    expect(await store.trust.decisionAsked(deep, NEVER_CANCELLED)).toEqual({ decision: 'trusted', inheritedFrom: inner });
    const sibling = mkdir(path.join(outer, 'other'));
    expect(await store.trust.decisionAsked(sibling, NEVER_CANCELLED)).toEqual({ decision: 'untrusted', inheritedFrom: outer });
  });

  it('resolves symlinks before walking ancestors', async () => {
    const { root, store } = makeTrustTree();
    const project = mkdir(path.join(root, 'work', 'project'));
    const child = mkdir(path.join(project, 'child'));
    const link = path.join(root, 'link');
    fs.symlinkSync(child, link);
    await store.trust.setAsked(project, 'trusted', NEVER_CANCELLED);
    expect(await store.trust.decisionAsked(link, NEVER_CANCELLED)).toEqual({ decision: 'trusted', inheritedFrom: project });
  });

  it('returns null when nothing on the path has a decision', async () => {
    const { root, store } = makeTrustTree();
    const project = mkdir(path.join(root, 'work', 'project'));
    expect(await store.trust.decisionAsked(project, NEVER_CANCELLED)).toEqual({ decision: null });
  });

  it('gives a missing path the decision of its nearest existing ancestor', async () => {
    const { root, store } = makeTrustTree();
    const project = mkdir(path.join(root, 'work', 'project'));
    await store.trust.setAsked(project, 'trusted', NEVER_CANCELLED);
    expect(await store.trust.decisionAsked(path.join(project, 'missing'), NEVER_CANCELLED)).toEqual({ decision: 'trusted', inheritedFrom: project });
  });

  it('applies a decision on home only to home itself', async () => {
    const { home, store } = makeTrustTree();
    const child = mkdir(path.join(home, 'code', 'project'));
    await store.trust.setAsked(home, 'trusted', NEVER_CANCELLED);
    expect(await store.trust.decisionAsked(home, NEVER_CANCELLED)).toEqual({ decision: 'trusted' });
    expect(await store.trust.decisionAsked(child, NEVER_CANCELLED)).toEqual({ decision: null });
  });

  it('applies a decision on an ancestor of home only to that ancestor', async () => {
    const { root, home, store } = makeTrustTree();
    const besideHome = mkdir(path.join(root, 'beside'));
    const underHome = mkdir(path.join(home, 'project'));
    await store.trust.setAsked(root, 'trusted', NEVER_CANCELLED);
    expect(await store.trust.decisionAsked(root, NEVER_CANCELLED)).toEqual({ decision: 'trusted' });
    expect(await store.trust.decisionAsked(besideHome, NEVER_CANCELLED)).toEqual({ decision: null });
    expect(await store.trust.decisionAsked(underHome, NEVER_CANCELLED)).toEqual({ decision: null });
    expect(await store.trust.decisionAsked(home, NEVER_CANCELLED)).toEqual({ decision: null });
  });

  it('still inherits from a directory below home', async () => {
    const { home, store } = makeTrustTree();
    const code = mkdir(path.join(home, 'code'));
    const project = mkdir(path.join(code, 'project'));
    await store.trust.setAsked(home, 'untrusted', NEVER_CANCELLED);
    await store.trust.setAsked(code, 'trusted', NEVER_CANCELLED);
    expect(await store.trust.decisionAsked(project, NEVER_CANCELLED)).toEqual({ decision: 'trusted', inheritedFrom: code });
  });
});

describe('trust case variants', () => {
  it.skipIf(!CASE_INSENSITIVE)('recognises a lowercase variant of home as home', async () => {
    const { home, store } = makeTrustTree((canonical) => canonical.toLowerCase());
    expect(home.toLowerCase()).not.toBe(home);
    const child = mkdir(path.join(home, 'project'));
    await store.trust.setAsked(home, 'trusted', NEVER_CANCELLED);
    expect(await store.trust.decisionAsked(child, NEVER_CANCELLED)).toEqual({ decision: null });
    expect(await store.trust.decisionAsked(home.toLowerCase(), NEVER_CANCELLED)).toEqual({ decision: 'trusted' });
  });

  it.skipIf(!CASE_INSENSITIVE)('treats a lowercase variant of home in set as home', async () => {
    const { home, store } = makeTrustTree();
    const child = mkdir(path.join(home, 'project'));
    await store.trust.setAsked(home.toLowerCase(), 'trusted', NEVER_CANCELLED);
    expect(await store.trust.decisionAsked(home, NEVER_CANCELLED)).toEqual({ decision: 'trusted' });
    expect(await store.trust.decisionAsked(child, NEVER_CANCELLED)).toEqual({ decision: null });
  });

  it.skipIf(!CASE_INSENSITIVE)('matches a decision typed in a different case', async () => {
    const { root, store } = makeTrustTree();
    const project = mkdir(path.join(root, 'Work', 'Project'));
    const deep = mkdir(path.join(project, 'src'));
    await store.trust.setAsked(path.join(root, 'work', 'project'), 'trusted', NEVER_CANCELLED);
    expect(await exactTrustOf(store, project)).toBe('trusted');
    expect(await store.trust.decisionAsked(path.join(root, 'WORK', 'PROJECT', 'SRC'), NEVER_CANCELLED)).toEqual({ decision: 'trusted', inheritedFrom: project });
    expect(await store.trust.decisionAsked(deep, NEVER_CANCELLED)).toEqual({ decision: 'trusted', inheritedFrom: project });
  });
});

describe('trust home containment with comparableContains', () => {
  it.runIf(CASE_INSENSITIVE)('a decision on a case variant of home is not inherited', async () => {
    const { home, store } = makeTrustTree((canonical) => canonical.toUpperCase());
    const child = mkdir(path.join(home, 'project'));
    await store.trust.setAsked(home.toLowerCase(), 'trusted', NEVER_CANCELLED);
    expect(await store.trust.decisionAsked(home, NEVER_CANCELLED)).toEqual({ decision: 'trusted' });
    expect(await store.trust.decisionAsked(child.toUpperCase(), NEVER_CANCELLED)).toEqual({ decision: null });
    expect(await store.trust.decisionAsked(child, NEVER_CANCELLED)).toEqual({ decision: null });
  });
});

describe('trust.setAsked', () => {
  it('refuses to trust the filesystem root', async () => {
    const { store } = makeTrustTree();
    await expect(store.trust.setAsked('/', 'trusted', NEVER_CANCELLED)).rejects.toThrow();
    expect(await exactTrustOf(store, '/')).toBeNull();
  });

  it('allows marking the filesystem root untrusted', async () => {
    const { store } = makeTrustTree();
    await store.trust.setAsked('/', 'untrusted', NEVER_CANCELLED);
    expect(await exactTrustOf(store, '/')).toBe('untrusted');
  });
});

describe('trust.clear', () => {
  it('clears an existing path through its native realpath', async () => {
    const { root, store } = makeTrustTree();
    const project = mkdir(path.join(root, 'work', 'project'));
    const link = path.join(root, 'link');
    fs.symlinkSync(project, link);
    await store.trust.setAsked(project, 'trusted', NEVER_CANCELLED);
    await store.trust.clearAsked(link, NEVER_CANCELLED);
    expect(await exactTrustOf(store, project)).toBeNull();
    expect(await store.trust.decisionAsked(project, NEVER_CANCELLED)).toEqual({ decision: null });
  });

  it('clears the stale row of a path that no longer exists', async () => {
    const { root, dbPath, store } = makeTrustTree();
    const project = mkdir(path.join(root, 'work', 'project'));
    await store.trust.setAsked(project, 'trusted', NEVER_CANCELLED);
    fs.rmSync(project, { recursive: true });
    await store.trust.clearAsked(project, NEVER_CANCELLED);
    const count = rawDb(dbPath).prepare('SELECT COUNT(*) AS n FROM trust WHERE path = ?').get(project) as { n: number };
    expect(count.n).toBe(0);
  });

  it('is idempotent', async () => {
    const { root, dbPath, store } = makeTrustTree();
    const project = mkdir(path.join(root, 'work', 'project'));
    const other = mkdir(path.join(root, 'work', 'other'));
    await store.trust.setAsked(project, 'trusted', NEVER_CANCELLED);
    await store.trust.setAsked(other, 'untrusted', NEVER_CANCELLED);
    await store.trust.clearAsked(project, NEVER_CANCELLED);
    await store.trust.clearAsked(project, NEVER_CANCELLED);
    await store.trust.clearAsked(path.join(root, 'never-existed'), NEVER_CANCELLED);
    expect(await exactTrustOf(store, other)).toBe('untrusted');
    const count = rawDb(dbPath).prepare('SELECT COUNT(*) AS n FROM trust').get() as { n: number };
    expect(count.n).toBe(1);
  });
});
