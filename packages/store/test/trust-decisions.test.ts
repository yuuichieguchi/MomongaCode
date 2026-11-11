import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openRuntimeStore } from '@momonga/store';
import type { RuntimeStore, RuntimeStoreOptions } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, makeStoreDir, openStoreAt, rawDb, UNASKED_COMMANDS } from './helpers.ts';

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
});

describe('openRuntimeStore home', () => {
  it('refuses a home that does not exist', () => {
    const dir = makeStoreDir();
    expect(() => openRuntimeStore(openOptions(dir, path.join(dir, 'missing-home')))).toThrow();
  });

  it('refuses options without a home', () => {
    const dir = makeStoreDir();
    const { home: _home, ...withoutHome } = openOptions(dir, dir);
    expect(() => openRuntimeStore(withoutHome as unknown as RuntimeStoreOptions)).toThrow();
  });
});

describe('trust.decisionFor', () => {
  it('returns the exact decision without inheritedFrom', () => {
    const { root, store } = makeTrustTree();
    const project = mkdir(path.join(root, 'work', 'project'));
    store.trust.set(project, 'trusted');
    expect(store.trust.decisionFor(project)).toEqual({ decision: 'trusted' });
    expect(store.trust.decisionFor(project).inheritedFrom).toBeUndefined();
  });

  it('inherits the nearest ancestor decision and names it', () => {
    const { root, store } = makeTrustTree();
    const outer = mkdir(path.join(root, 'work'));
    const inner = mkdir(path.join(outer, 'project'));
    const deep = mkdir(path.join(inner, 'src', 'lib'));
    store.trust.set(outer, 'untrusted');
    store.trust.set(inner, 'trusted');
    expect(store.trust.decisionFor(deep)).toEqual({ decision: 'trusted', inheritedFrom: inner });
    const sibling = mkdir(path.join(outer, 'other'));
    expect(store.trust.decisionFor(sibling)).toEqual({ decision: 'untrusted', inheritedFrom: outer });
  });

  it('resolves symlinks before walking ancestors', () => {
    const { root, store } = makeTrustTree();
    const project = mkdir(path.join(root, 'work', 'project'));
    const child = mkdir(path.join(project, 'child'));
    const link = path.join(root, 'link');
    fs.symlinkSync(child, link);
    store.trust.set(project, 'trusted');
    expect(store.trust.decisionFor(link)).toEqual({ decision: 'trusted', inheritedFrom: project });
  });

  it('returns null when nothing on the path has a decision', () => {
    const { root, store } = makeTrustTree();
    const project = mkdir(path.join(root, 'work', 'project'));
    expect(store.trust.decisionFor(project)).toEqual({ decision: null });
  });

  it('returns null for a missing path even under a trusted ancestor', () => {
    const { root, store } = makeTrustTree();
    const project = mkdir(path.join(root, 'work', 'project'));
    store.trust.set(project, 'trusted');
    expect(store.trust.decisionFor(path.join(project, 'missing'))).toEqual({ decision: null });
  });

  it('applies a decision on home only to home itself', () => {
    const { home, store } = makeTrustTree();
    const child = mkdir(path.join(home, 'code', 'project'));
    store.trust.set(home, 'trusted');
    expect(store.trust.decisionFor(home)).toEqual({ decision: 'trusted' });
    expect(store.trust.decisionFor(child)).toEqual({ decision: null });
  });

  it('applies a decision on an ancestor of home only to that ancestor', () => {
    const { root, home, store } = makeTrustTree();
    const besideHome = mkdir(path.join(root, 'beside'));
    const underHome = mkdir(path.join(home, 'project'));
    store.trust.set(root, 'trusted');
    expect(store.trust.decisionFor(root)).toEqual({ decision: 'trusted' });
    expect(store.trust.decisionFor(besideHome)).toEqual({ decision: null });
    expect(store.trust.decisionFor(underHome)).toEqual({ decision: null });
    expect(store.trust.decisionFor(home)).toEqual({ decision: null });
  });

  it('still inherits from a directory below home', () => {
    const { home, store } = makeTrustTree();
    const code = mkdir(path.join(home, 'code'));
    const project = mkdir(path.join(code, 'project'));
    store.trust.set(home, 'untrusted');
    store.trust.set(code, 'trusted');
    expect(store.trust.decisionFor(project)).toEqual({ decision: 'trusted', inheritedFrom: code });
  });
});

describe('trust case variants', () => {
  it.skipIf(!CASE_INSENSITIVE)('recognises a lowercase variant of home as home', () => {
    const { home, store } = makeTrustTree((canonical) => canonical.toLowerCase());
    expect(home.toLowerCase()).not.toBe(home);
    const child = mkdir(path.join(home, 'project'));
    store.trust.set(home, 'trusted');
    expect(store.trust.decisionFor(child)).toEqual({ decision: null });
    expect(store.trust.decisionFor(home.toLowerCase())).toEqual({ decision: 'trusted' });
  });

  it.skipIf(!CASE_INSENSITIVE)('treats a lowercase variant of home in set as home', () => {
    const { home, store } = makeTrustTree();
    const child = mkdir(path.join(home, 'project'));
    store.trust.set(home.toLowerCase(), 'trusted');
    expect(store.trust.decisionFor(home)).toEqual({ decision: 'trusted' });
    expect(store.trust.decisionFor(child)).toEqual({ decision: null });
  });

  it.skipIf(!CASE_INSENSITIVE)('matches a decision typed in a different case', () => {
    const { root, store } = makeTrustTree();
    const project = mkdir(path.join(root, 'Work', 'Project'));
    const deep = mkdir(path.join(project, 'src'));
    store.trust.set(path.join(root, 'work', 'project'), 'trusted');
    expect(store.trust.get(project)).toBe('trusted');
    expect(store.trust.decisionFor(path.join(root, 'WORK', 'PROJECT', 'SRC'))).toEqual({ decision: 'trusted', inheritedFrom: project });
    expect(store.trust.decisionFor(deep)).toEqual({ decision: 'trusted', inheritedFrom: project });
  });
});

describe('trust home containment with comparableContains', () => {
  it.runIf(CASE_INSENSITIVE)('a decision on a case variant of home is not inherited', () => {
    const { home, store } = makeTrustTree((canonical) => canonical.toUpperCase());
    const child = mkdir(path.join(home, 'project'));
    store.trust.set(home.toLowerCase(), 'trusted');
    expect(store.trust.decisionFor(home)).toEqual({ decision: 'trusted' });
    expect(store.trust.decisionFor(child.toUpperCase())).toEqual({ decision: null });
    expect(store.trust.decisionFor(child)).toEqual({ decision: null });
  });
});

describe('trust.set', () => {
  it('refuses to trust the filesystem root', () => {
    const { store } = makeTrustTree();
    expect(() => store.trust.set('/', 'trusted')).toThrow();
    expect(store.trust.get('/')).toBeUndefined();
  });

  it('allows marking the filesystem root untrusted', () => {
    const { store } = makeTrustTree();
    store.trust.set('/', 'untrusted');
    expect(store.trust.get('/')).toBe('untrusted');
  });
});

describe('trust.clear', () => {
  it('clears an existing path through its native realpath', () => {
    const { root, store } = makeTrustTree();
    const project = mkdir(path.join(root, 'work', 'project'));
    const link = path.join(root, 'link');
    fs.symlinkSync(project, link);
    store.trust.set(project, 'trusted');
    store.trust.clear(link);
    expect(store.trust.get(project)).toBeUndefined();
    expect(store.trust.decisionFor(project)).toEqual({ decision: null });
  });

  it('clears the stale row of a path that no longer exists', () => {
    const { root, dbPath, store } = makeTrustTree();
    const project = mkdir(path.join(root, 'work', 'project'));
    store.trust.set(project, 'trusted');
    fs.rmSync(project, { recursive: true });
    store.trust.clear(project);
    const count = rawDb(dbPath).prepare('SELECT COUNT(*) AS n FROM trust WHERE path = ?').get(project) as { n: number };
    expect(count.n).toBe(0);
  });

  it('is idempotent', () => {
    const { root, dbPath, store } = makeTrustTree();
    const project = mkdir(path.join(root, 'work', 'project'));
    const other = mkdir(path.join(root, 'work', 'other'));
    store.trust.set(project, 'trusted');
    store.trust.set(other, 'untrusted');
    store.trust.clear(project);
    expect(() => store.trust.clear(project)).not.toThrow();
    expect(() => store.trust.clear(path.join(root, 'never-existed'))).not.toThrow();
    expect(store.trust.get(other)).toBe('untrusted');
    const count = rawDb(dbPath).prepare('SELECT COUNT(*) AS n FROM trust').get() as { n: number };
    expect(count.n).toBe(1);
  });
});
