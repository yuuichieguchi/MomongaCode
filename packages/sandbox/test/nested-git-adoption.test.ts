import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { makeTempDir } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const GIT = process.platform === 'darwin' ? '/usr/bin/git' : 'git';

describe('what git itself adopts from a planted nested git directory (real git)', () => {
  let created: string[] = [];

  afterEach(() => {
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
    created = [];
  });

  const base = (): string => {
    const dir = fs.realpathSync(makeTempDir());
    created.push(dir);
    return dir;
  };

  const git = (cwd: string, ...args: string[]) => {
    const done = spawnSync(GIT, ['-c', 'protocol.file.allow=always', ...args], {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] as string,
        HOME: cwd,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    });
    return { status: done.status, stderr: done.stderr, stdout: done.stdout };
  };

  const ok = (cwd: string, ...args: string[]): void => {
    const done = git(cwd, ...args);
    if (done.status !== 0) throw new Error(`git ${args.join(' ')}: ${done.stderr}`);
  };

  const withSubmodules = (names: ReadonlyArray<{ name: string; at: string }>) => {
    const root = base();
    const sub = path.join(root, 'sub');
    const parent = path.join(root, 'parent');
    for (const directory of [sub, parent]) {
      fs.mkdirSync(directory);
      ok(directory, 'init', '-q', '-b', 'main');
    }
    fs.writeFileSync(path.join(sub, 'f'), 'f');
    ok(sub, 'add', 'f');
    ok(sub, 'commit', '-q', '-m', 'sub');
    const head = git(sub, 'rev-parse', 'HEAD').stdout.trim();
    const modulesFile = names.map(({ name, at }) => `[submodule "${name}"]\n\tpath = ${at}\n\turl = ${sub}\n`).join('');
    fs.writeFileSync(path.join(parent, '.gitmodules'), modulesFile);
    ok(parent, 'add', '.gitmodules');
    for (const { at } of names) ok(parent, 'update-index', '--add', '--cacheinfo', `160000,${head},${at}`);
    ok(parent, 'commit', '-q', '-m', 'parent');
    const clone = path.join(root, 'clone');
    ok(root, 'clone', '-q', parent, clone);
    const marker = path.join(root, 'hook-ran');
    const plant = (name: string): string => {
      const gitDir = path.join(clone, '.git', 'modules', name);
      fs.mkdirSync(path.dirname(gitDir), { recursive: true });
      const checkout = path.join(root, `planted-${name.replaceAll('/', '-')}`);
      ok(root, 'clone', '-q', sub, checkout);
      fs.renameSync(path.join(checkout, '.git'), gitDir);
      const hook = path.join(gitDir, 'hooks', 'post-checkout');
      fs.writeFileSync(hook, `#!/bin/sh\n: > ${marker}\n`, { mode: 0o755 });
      return gitDir;
    };
    return { root, clone, marker, plant };
  };

  it('adopts a git directory planted at .git/modules/<name>, and its hook runs (the threat the module anchor closes)', () => {
    const fixture = withSubmodules([{ name: 'subm', at: 'subm' }]);
    fixture.plant('subm');
    const update = git(fixture.clone, 'submodule', 'update', '--init', 'subm');
    expect(update.status).toBe(0);
    expect(fs.existsSync(fixture.marker)).toBe(true);
  });

  it('refuses a git directory planted inside another module git directory, so the pattern needs no anchor there', () => {
    const nested = 'a/refs/heads/config';
    const fixture = withSubmodules([
      { name: 'a', at: 'pa' },
      { name: nested, at: 'pb' },
    ]);
    const outer = fixture.plant('a');
    fs.rmSync(path.join(outer, 'hooks', 'post-checkout'));
    fixture.plant(nested);
    const update = git(fixture.clone, 'submodule', 'update', '--init', 'pb');
    expect(update.status).not.toBe(0);
    expect(update.stderr).toMatch(/another submodule's git dir|refusing/);
    expect(fs.existsSync(fixture.marker)).toBe(false);
  });

  it('gives the new worktree an administrative directory without the planted config.worktree, whether git prunes the dangling one or keeps it', () => {
    const root = base();
    const main = path.join(root, 'main');
    fs.mkdirSync(main);
    ok(main, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(main, 'f'), 'f');
    ok(main, 'add', 'f');
    ok(main, 'commit', '-q', '-m', 'one');
    const planted = path.join(main, '.git', 'worktrees', 'wt');
    fs.mkdirSync(planted, { recursive: true });
    fs.writeFileSync(path.join(planted, 'config.worktree'), '[core]\n\tfsmonitor = /bin/false\n');
    fs.writeFileSync(path.join(planted, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(planted, 'commondir'), '../..\n');
    fs.writeFileSync(path.join(planted, 'gitdir'), `${path.join(root, 'missing', '.git')}\n`);
    const added = git(main, 'worktree', 'add', '-q', path.join(root, 'wt'), '-b', 'topic');
    expect(added.status).toBe(0);
    const pointer = fs.readFileSync(path.join(root, 'wt', '.git'), 'utf8').trim().replace(/^gitdir: /, '');
    expect(fs.existsSync(path.join(pointer, 'config.worktree'))).toBe(false);
  });

  it('never adopts an existing worktree administrative directory: git worktree add picks a fresh name', () => {
    const root = base();
    const main = path.join(root, 'main');
    fs.mkdirSync(main);
    ok(main, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(main, 'f'), 'f');
    ok(main, 'add', 'f');
    ok(main, 'commit', '-q', '-m', 'one');
    const planted = path.join(main, '.git', 'worktrees', 'wt');
    fs.mkdirSync(planted, { recursive: true });
    const plantedConfig = '[core]\n\tfsmonitor = /bin/false\n';
    fs.writeFileSync(path.join(planted, 'config.worktree'), plantedConfig);
    fs.writeFileSync(path.join(planted, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(planted, 'commondir'), '../..\n');
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.writeFileSync(path.join(root, 'elsewhere', '.git'), `gitdir: ${planted}\n`);
    fs.writeFileSync(path.join(planted, 'gitdir'), `${path.join(root, 'elsewhere', '.git')}\n`);
    const added = git(main, 'worktree', 'add', '-q', path.join(root, 'wt'), '-b', 'topic');
    expect(added.status).toBe(0);
    expect(fs.readFileSync(path.join(planted, 'config.worktree'), 'utf8')).toBe(plantedConfig);
    expect(fs.readFileSync(path.join(planted, 'gitdir'), 'utf8')).toBe(`${path.join(root, 'elsewhere', '.git')}\n`);
    expect(fs.readFileSync(path.join(root, 'wt', '.git'), 'utf8')).toBe(`gitdir: ${path.join(main, '.git', 'worktrees', 'wt1')}\n`);
  });
});
