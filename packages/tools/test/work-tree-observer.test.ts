import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeFileSystem, sha256Hex } from '@momonga/foundation';
import { createTempDir, REAL_PROCESS_TEST_TIMEOUT_MS, TEST_UNPROTECTED_LAUNCH } from '@momonga/testkit';
import { OBSERVED_UNTRACKED_FILE_MAX_BYTES, WorkTreeObservationError, createGitWorkTreeObserver, observedToolFiles } from '@momonga/tools';
import type { ObservedFile, WorkTreeObserver } from '@momonga/tools';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SYSTEM_GIT = '/usr/bin/git';

let root = '';
let project = '';
let storeRoot = '';
let gitEnv: NodeJS.ProcessEnv = {};
const savedHome = process.env['HOME'];

const gitOk = (cwd: string, ...args: string[]): string => {
  const result = spawnSync(SYSTEM_GIT, args, { cwd, env: gitEnv, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
};

const put = (name: string, content: string): string => {
  const target = path.join(project, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
};

const signal = (): AbortSignal => new AbortController().signal;

const MANIFESTS = ['package.json', 'Makefile'];

const observerFor = (cwd: string, trusted = true, manifests: readonly string[] = MANIFESTS): WorkTreeObserver =>
  createGitWorkTreeObserver({ storeRoot, cwd, trusted, manifests }, TEST_UNPROTECTED_LAUNCH);

const sorted = (files: readonly ObservedFile[]): ObservedFile[] => [...files].sort((a, b) => a.path.localeCompare(b.path) || a.change.localeCompare(b.change));

const observe = async (observer: WorkTreeObserver, act: () => void): Promise<ObservedFile[]> => {
  const opening = await observer.mark(signal());
  expect(opening).toBeDefined();
  act();
  const closed = await observer.changedSince(opening!, signal());
  return sorted(closed.files);
};

beforeEach(() => {
  if (!fs.existsSync(SYSTEM_GIT)) throw new Error(`system git required at ${SYSTEM_GIT}`);
  root = createTempDir();
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  process.env['HOME'] = home;
  gitEnv = {
    HOME: home,
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  project = path.join(root, 'project');
  storeRoot = path.join(root, 'state', 'observer');
  fs.mkdirSync(project);
  gitOk(project, 'init', '-q');
  put('.gitignore', 'build/\n');
  put('src/a.ts', 'one\n');
  put('src/keep.ts', 'keep\n');
  put('src/old.ts', 'old\n');
  gitOk(project, 'add', '.');
  gitOk(project, 'commit', '-q', '-m', 'init');
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the git work-tree observer on a real temporary repository', () => {
  it('reports an in-place edit, a created file and a deleted file', async () => {
    const observer = observerFor(project);
    const files = await observe(observer, () => {
      put('src/a.ts', 'two\n');
      put('src/new.ts', 'fresh\n');
      fs.rmSync(path.join(project, 'src/old.ts'));
    });
    expect(files).toEqual([
      { path: path.join(project, 'src/a.ts'), change: 'write' },
      { path: path.join(project, 'src/new.ts'), change: 'write' },
      { path: path.join(project, 'src/old.ts'), change: 'remove' },
    ]);
  });

  it('reports a rename as a remove and a write', async () => {
    const files = await observe(observerFor(project), () => {
      fs.renameSync(path.join(project, 'src/keep.ts'), path.join(project, 'src/moved.ts'));
    });
    expect(files).toEqual([
      { path: path.join(project, 'src/keep.ts'), change: 'remove' },
      { path: path.join(project, 'src/moved.ts'), change: 'write' },
    ]);
  });

  it('hashes each written file with the SHA-256 of its new content and gives a removed file no hash', async () => {
    const files = await observe(observerFor(project), () => {
      put('src/a.ts', 'hashed\n');
      fs.rmSync(path.join(project, 'src/old.ts'));
    });
    expect(await observedToolFiles(nodeFileSystem, files ?? [], signal())).toEqual([
      { path: path.join(project, 'src/a.ts'), sha256: sha256Hex('hashed\n'), access: 'write' },
      { path: path.join(project, 'src/old.ts'), access: 'remove' },
    ]);
  });

  it('reports [] when nothing changed', async () => {
    expect(await observe(observerFor(project), () => {})).toEqual([]);
  });

  it('does not report a file the project ignores', async () => {
    const files = await observe(observerFor(project), () => {
      put('build/out.js', 'generated\n');
      put('src/a.ts', 'seen\n');
    });
    expect(files).toEqual([{ path: path.join(project, 'src/a.ts'), change: 'write' }]);
  });

  it('runs neither the core.fsmonitor hook nor a clean filter of the project config', async () => {
    const fsmonitorMarker = path.join(root, 'fsmonitor-ran');
    const filterMarker = path.join(root, 'filter-ran');
    const script = (marker: string): string => {
      const file = path.join(root, `${path.basename(marker)}.sh`);
      fs.writeFileSync(file, `#!/bin/sh\ntouch "${marker}"\ncat\n`, { mode: 0o755 });
      return file;
    };
    gitOk(project, 'config', 'core.fsmonitor', script(fsmonitorMarker));
    gitOk(project, 'config', 'filter.spy.clean', script(filterMarker));
    put('.gitattributes', '* filter=spy\n');
    const files = await observe(observerFor(project), () => {
      put('src/a.ts', 'filtered?\n');
    });
    expect(files).toEqual([{ path: path.join(project, 'src/a.ts'), change: 'write' }]);
    expect(fs.existsSync(fsmonitorMarker)).toBe(false);
    expect(fs.existsSync(filterMarker)).toBe(false);
  });

  it('leaves the project index untouched and writes only under the private store', async () => {
    const index = path.join(project, '.git', 'index');
    const before = fs.readFileSync(index);
    await observe(observerFor(project), () => {
      put('src/a.ts', 'private\n');
    });
    expect(fs.readFileSync(index).equals(before)).toBe(true);
    expect(fs.readdirSync(storeRoot)).toEqual([sha256Hex(project)]);
  });

  it('returns undefined in a folder that is not a git work tree', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'x.txt'), 'x');
    expect(await observerFor(plain).mark(signal())).toBeUndefined();
  });

  it('returns undefined in an untrusted folder and runs no git there', async () => {
    gitOk(project, 'config', 'core.fsmonitor', path.join(root, 'never.sh'));
    expect(await observerFor(project, false).mark(signal())).toBeUndefined();
    expect(fs.existsSync(storeRoot)).toBe(false);
  });

  it('lets two sessions on one project share one store without corruption', async () => {
    const first = observerFor(project);
    const second = observerFor(project);
    const firstOpen = await first.mark(signal());
    const secondOpen = await second.mark(signal());
    put('src/a.ts', 'first\n');
    const firstClosed = await first.changedSince(firstOpen!, signal());
    put('src/new.ts', 'second\n');
    const secondClosed = await second.changedSince(secondOpen!, signal());
    expect(sorted(firstClosed!.files)).toEqual([{ path: path.join(project, 'src/a.ts'), change: 'write' }]);
    expect(sorted(secondClosed!.files)).toEqual([
      { path: path.join(project, 'src/a.ts'), change: 'write' },
      { path: path.join(project, 'src/new.ts'), change: 'write' },
    ]);
    const after = await first.changedSince(firstClosed!.mark, signal());
    expect(sorted(after!.files)).toEqual([{ path: path.join(project, 'src/new.ts'), change: 'write' }]);
  });
  it('observes the repository of a session started in a subfolder of it, in the store of the repository root', async () => {
    const files = await observe(observerFor(path.join(project, 'src')), () => {
      put('src/a.ts', 'below\n');
      put('top.txt', 'top\n');
    });
    expect(files).toEqual([
      { path: path.join(project, 'src/a.ts'), change: 'write' },
      { path: path.join(project, 'top.txt'), change: 'write' },
    ]);
    expect(fs.readdirSync(storeRoot)).toEqual([sha256Hex(project)]);
  });

  it('does not copy a file the repository does not track that is over the size bound, and names it', async () => {
    const observer = observerFor(project);
    const opening = await observer.mark(signal());
    put('big.bin', 'x'.repeat(OBSERVED_UNTRACKED_FILE_MAX_BYTES + 1));
    put('src/a.ts', 'small\n');
    const closed = await observer.changedSince(opening!, signal());
    expect(sorted(closed.files)).toEqual([{ path: path.join(project, 'src/a.ts'), change: 'write' }]);
    expect(closed.oversized).toEqual([path.join(project, 'big.bin')]);
  });

  it('marks a window complete when nothing it could hide is a manifest of the verification', async () => {
    const opening = await observerFor(project).mark(signal());
    put('src/a.ts', 'two\n');
    expect((await observerFor(project).changedSince(opening!, signal())).complete).toBe(true);
  });

  it('marks a window complete when the only ignored file is not named as a manifest', async () => {
    const opening = await observerFor(project).mark(signal());
    put('build/out.js', 'generated\n');
    expect((await observerFor(project).changedSince(opening!, signal())).complete).toBe(true);
  });

  it('marks a window incomplete when an ignored file with a manifest name exists at its close, so a manifest the observer cannot see may have changed', async () => {
    const opening = await observerFor(project).mark(signal());
    put('build/package.json', '{}\n');
    const closed = await observerFor(project).changedSince(opening!, signal());
    expect(closed.complete).toBe(false);
    expect(sorted(closed.files)).toEqual([]);
  });

  it('marks a window incomplete when an ignored manifest existed at its open and was removed in the window', async () => {
    put('build/Makefile', 'all:\n');
    const opening = await observerFor(project).mark(signal());
    fs.rmSync(path.join(project, 'build/Makefile'));
    expect((await observerFor(project).changedSince(opening!, signal())).complete).toBe(false);
  });

  it('marks a window incomplete when a manifest over the size bound is rewritten in it, which the file list does not show', async () => {
    put('package.json', 'x'.repeat(OBSERVED_UNTRACKED_FILE_MAX_BYTES + 1));
    const opening = await observerFor(project).mark(signal());
    put('package.json', 'y'.repeat(OBSERVED_UNTRACKED_FILE_MAX_BYTES + 2));
    expect((await observerFor(project).changedSince(opening!, signal())).complete).toBe(false);
  });

  it('marks a window complete when the file over the size bound is not named as a manifest', async () => {
    const opening = await observerFor(project).mark(signal());
    put('big.bin', 'x'.repeat(OBSERVED_UNTRACKED_FILE_MAX_BYTES + 1));
    expect((await observerFor(project).changedSince(opening!, signal())).complete).toBe(true);
  });

  it('marks a window incomplete when a nested repository holds part of the work tree, because its edits are not seen', async () => {
    const opening = await observerFor(project).mark(signal());
    put('vendor/lib/package.json', '{}\n');
    gitOk(path.join(project, 'vendor/lib'), 'init', '-q');
    gitOk(path.join(project, 'vendor/lib'), 'add', '.');
    gitOk(path.join(project, 'vendor/lib'), 'commit', '-q', '-m', 'lib');
    put('vendor/lib/src/x.ts', 'x\n');
    expect((await observerFor(project).changedSince(opening!, signal())).complete).toBe(false);
  });

  it('a git command that fails is an error naming the reason, not an observation of nothing', async () => {
    const observer = observerFor(project);
    const opening = await observer.mark(signal());
    const locked = put('src/locked.ts', 'locked\n');
    fs.chmodSync(locked, 0o000);
    try {
      await expect(observer.changedSince(opening!, signal())).rejects.toThrow(WorkTreeObservationError);
      await expect(observer.changedSince(opening!, signal())).rejects.toThrow(/git add exited with/);
    } finally {
      fs.chmodSync(locked, 0o644);
    }
  });
});
