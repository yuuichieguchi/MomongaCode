import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { createGitWorkTreeObserver, observedToolFiles } from '@momonga/tools';
import type { ObservedFile, WorkTreeObserver } from '@momonga/tools';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const SYSTEM_GIT = '/usr/bin/git';

let root = '';
let project = '';
let storeDir = '';
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

const observerFor = (workTree: string, trusted = true): WorkTreeObserver => createGitWorkTreeObserver({ storeDir, workTree, trusted });

const sorted = (files: readonly ObservedFile[]): ObservedFile[] => [...files].sort((a, b) => a.path.localeCompare(b.path) || a.change.localeCompare(b.change));

const observe = async (observer: WorkTreeObserver, act: () => void): Promise<ObservedFile[] | undefined> => {
  const opening = await observer.mark(signal());
  expect(opening).toBeDefined();
  act();
  const closed = await observer.changedSince(opening!, signal());
  return closed === undefined ? undefined : sorted(closed.files);
};

beforeEach(() => {
  if (!fs.existsSync(SYSTEM_GIT)) throw new Error(`system git required at ${SYSTEM_GIT}`);
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-observer-')));
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
  storeDir = path.join(root, 'state', 'observer');
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
    expect(await observedToolFiles(files ?? [], signal())).toEqual([
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
    expect(fs.existsSync(storeDir)).toBe(true);
  });

  it('returns undefined in a folder that is not a git work tree', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'x.txt'), 'x');
    expect(await createGitWorkTreeObserver({ storeDir, workTree: plain, trusted: true }).mark(signal())).toBeUndefined();
  });

  it('returns undefined in an untrusted folder and runs no git there', async () => {
    gitOk(project, 'config', 'core.fsmonitor', path.join(root, 'never.sh'));
    expect(await observerFor(project, false).mark(signal())).toBeUndefined();
    expect(fs.existsSync(storeDir)).toBe(false);
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
});
