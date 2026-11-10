import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevStateError, STATE_DIR_ENV, stateDirOf } from './dev-state.ts';
import { createTempRoot, removeTempRoot } from './temp.ts';

describe('the state directory of the development tools', () => {
  let temp = '';

  beforeEach(() => {
    temp = fs.realpathSync(createTempRoot());
  });

  afterEach(() => {
    removeTempRoot(temp);
  });

  const checkoutWithGitDirectory = (): string => {
    const root = path.join(temp, 'main');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    return root;
  };

  const worktreeOf = (main: string, gitdirLine: string): string => {
    const worktreeGitDir = path.join(main, '.git', 'worktrees', 'w');
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
    const root = path.join(temp, 'w');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.git'), `${gitdirLine}\n`);
    return root;
  };

  it('names the variable it reads', () => {
    expect(STATE_DIR_ENV).toBe('MOMONGA_DEV_STATE_DIR');
  });

  it('uses an absolute directory given in the environment', () => {
    expect(stateDirOf(checkoutWithGitDirectory(), { MOMONGA_DEV_STATE_DIR: '/abs/dir' })).toBe('/abs/dir');
  });

  it('refuses a relative directory given in the environment', () => {
    expect(() => stateDirOf(checkoutWithGitDirectory(), { MOMONGA_DEV_STATE_DIR: 'rel/dir' })).toThrow('MOMONGA_DEV_STATE_DIR must be an absolute path, got "rel/dir"');
  });

  it('treats an empty directory in the environment as unset', () => {
    const root = checkoutWithGitDirectory();
    expect(stateDirOf(root, { MOMONGA_DEV_STATE_DIR: '' })).toBe(path.join(root, '.git', 'momonga-dev'));
  });

  it('lives in the git directory of a main checkout', () => {
    const root = checkoutWithGitDirectory();
    expect(stateDirOf(root, {})).toBe(path.join(root, '.git', 'momonga-dev'));
  });

  it('lives in the common git directory of a worktree named by an absolute gitdir', () => {
    const main = checkoutWithGitDirectory();
    const root = worktreeOf(main, `gitdir: ${path.join(main, '.git', 'worktrees', 'w')}`);
    expect(stateDirOf(root, {})).toBe(path.join(main, '.git', 'momonga-dev'));
  });

  it('lives in the common git directory of a worktree named by a relative gitdir', () => {
    const main = checkoutWithGitDirectory();
    const root = worktreeOf(main, 'gitdir: ../main/.git/worktrees/w');
    expect(stateDirOf(root, {})).toBe(path.join(main, '.git', 'momonga-dev'));
  });

  it('lives in the gitdir itself when it has no commondir, as a submodule', () => {
    const gitdir = path.join(temp, 'modules', 'sub');
    fs.mkdirSync(gitdir, { recursive: true });
    const root = path.join(temp, 'sub');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${gitdir}\n`);
    expect(stateDirOf(root, {})).toBe(path.join(gitdir, 'momonga-dev'));
  });

  it('lives in the cache of a tree that has no git entry', () => {
    const root = path.join(temp, 'plain');
    fs.mkdirSync(root);
    expect(stateDirOf(root, {})).toBe(path.join(root, '.cache', 'momonga-dev'));
  });

  it('refuses a git file that names no gitdir', () => {
    const root = path.join(temp, 'odd');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, '.git'), 'hello\n');
    let thrown: unknown;
    try {
      stateDirOf(root, {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DevStateError);
    expect((thrown as Error).message).toBe(`${root}/.git is neither a git directory nor a gitdir file`);
  });

  it('agrees with git about the common directory of a real main checkout and its worktree', () => {
    const home = path.join(temp, 'home');
    fs.mkdirSync(home);
    const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
    const git = (cwd: string, args: readonly string[]): string => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, env, encoding: 'utf8' }).trim();
    const main = path.join(temp, 'repo');
    fs.mkdirSync(main);
    git(main, ['init', '-q']);
    fs.writeFileSync(path.join(main, 'file.txt'), 'x\n');
    git(main, ['add', 'file.txt']);
    git(main, ['commit', '-q', '-m', 'first']);
    const worktree = path.join(temp, 'repo-worktree');
    git(main, ['worktree', 'add', '-q', worktree]);
    for (const checkout of [main, worktree]) {
      const common = git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      expect(stateDirOf(checkout, {})).toBe(path.join(common, 'momonga-dev'));
    }
  });
});
