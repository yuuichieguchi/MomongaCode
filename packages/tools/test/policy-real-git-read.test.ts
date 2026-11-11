import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { makeRealWorkspace } from './real-workspace.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const prepared = () => {
  const workspace = makeRealWorkspace();
  workspace.initRepository();
  workspace.git(workspace.project, 'remote', 'add', 'origin', 'https://example.invalid/r.git');
  return workspace;
};

describe('git reflog goes through the option table (real git 2.54)', () => {
  it('real git writes the chosen content to the chosen file for show --output', () => {
    const workspace = prepared();
    const result = workspace.git(workspace.project, 'reflog', 'show', '--output=Makefile', '--format=format:EVIL');
    expect(result.status).toBe(0);
    expect(workspace.read('Makefile')).toContain('EVIL');
  });

  it.each([
    'git reflog show --output=pwn --format=format:EVIL',
    'git reflog --output=pwn',
    'git reflog -p --ext-diff',
    'git reflog expire --all',
    "git reflog delete 'HEAD@{0}'",
    'git reflog drop --all',
    'git reflog list --output=pwn',
  ])('asks for %s in manual and plan mode', async (command) => {
    const workspace = prepared();
    expect((await workspace.decide(command, { mode: 'manual' })).kind).toBe('ask');
    expect((await workspace.decide(command, { mode: 'plan' })).kind).toBe('ask');
  });

  it.each(['git reflog', 'git reflog show', 'git reflog --oneline -n 1', 'git reflog list', 'git reflog exists HEAD', 'git reflog show HEAD'])('allows %s', async (command) => {
    const workspace = prepared();
    expect((await workspace.decide(command)).kind).toBe('allow');
    expect(workspace.runBash(command).status).toBe(0);
  });

  it('treats expire after an option as a revision, as real git does, and still asks because the table does not declare it', () => {
    const workspace = prepared();
    const result = workspace.git(workspace.project, 'reflog', '--oneline', 'expire', '--all');
    expect(result.status).toBe(128);
  });

  it('reads the operands of show as paths', async () => {
    const workspace = prepared();
    expect((await workspace.decide('git reflog show /etc/passwd')).kind).toBe('ask');
  });
});

describe('numeric count options (-1, -5) are non-path flags where the program takes them', () => {
  it.each(['git log -1', 'git log -3 --oneline', 'head -2 tracked', 'tail -1 tracked'])('allows %s and real tools accept it', async (command) => {
    const workspace = prepared();
    expect((await workspace.decide(command)).kind).toBe('allow');
    expect(workspace.runBash(command).status).toBe(0);
  });

  it('still asks for a numeric option on a program that does not take one', async () => {
    const workspace = prepared();
    expect((await workspace.decide('cat -1 tracked')).kind).toBe('ask');
  });
});

describe('git branch, tag and remote: listing grammar per subcommand', () => {
  it.each(['git tag -v -l v1', 'git tag -a -l', 'git tag -d v1', 'git tag newtag', 'git branch newbranch', 'git branch -d x', 'git branch -m a b', 'git branch -a -l -D'])(
    'asks for %s',
    async (command) => {
      const workspace = prepared();
      expect((await workspace.decide(command)).kind).toBe('ask');
    },
  );

  it.each(['git branch', 'git branch -a', 'git branch -vv', 'git branch --show-current', 'git branch --contains HEAD', 'git branch -l main', 'git tag', 'git tag -l', 'git tag -n1', "git tag --list 'v*'", 'git tag --sort=-creatordate'])(
    'allows %s',
    async (command) => {
      const workspace = prepared();
      expect((await workspace.decide(command)).kind).toBe('allow');
    },
  );

  it('creates no branch for git branch -l new in real git', () => {
    const workspace = prepared();
    workspace.git(workspace.project, 'branch', '-l', 'new');
    expect(workspace.git(workspace.project, 'branch', '--list', 'new').stdout).toBe('');
  });

  it('asks for git remote show without -n, which contacts the named remote or URL, and allows the cached form', async () => {
    const workspace = prepared();
    expect((await workspace.decide('git remote show origin')).kind).toBe('ask');
    expect((await workspace.decide('git remote show https://example.invalid/x')).kind).toBe('ask');
    expect((await workspace.decide('git remote show -n origin')).kind).toBe('allow');
    expect((await workspace.decide('git remote get-url origin')).kind).toBe('allow');
    expect((await workspace.decide('git remote -v')).kind).toBe('allow');
    expect((await workspace.decide('git remote')).kind).toBe('allow');
    expect((await workspace.decide('git remote add x https://example.invalid/y')).kind).toBe('ask');
  });

  it('shows a configured remote from the cache with -n without any network access', () => {
    const workspace = prepared();
    const result = workspace.git(workspace.project, 'remote', 'show', '-n', 'origin');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('https://example.invalid/r.git');
  });
});
