import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendPermissionRule, loadSettings, systemFileLockPorts } from '@momonga/config';
import type { PermissionRule } from '@momonga/config';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { makeDir, makeTree } from './helpers.ts';

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    stdio: 'ignore',
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' },
  });
};

const repository = (root: string): string => {
  fs.mkdirSync(path.join(root, 'sub', 'deeper'), { recursive: true, mode: 0o700 });
  git(root, 'init', '-q');
  return root;
};

const persist = (home: string, projectDir: string, rule: string): Promise<void> =>
  appendPermissionRule({ ports: systemFileLockPorts, home, projectDir, rule, effect: 'allow' });

const localRules = async (home: string, projectDir: string): Promise<PermissionRule[]> => {
  const trust = { isTrusted: (): boolean => true };
  const result = await loadSettings({ home, projectDir, cli: {}, trust });
  return result.rules.filter((rule) => rule.origin === 'local');
};

const ruleTexts = (rules: readonly PermissionRule[]): string[] => rules.map((rule) => rule.text);

describe('allow_always grants key on the worktree root', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('applies a rule persisted from a subdirectory when the session starts at the repository root', async () => {
    const tree = makeTree();
    const repo = repository(tree.project);
    await persist(tree.home, path.join(repo, 'sub'), 'Bash(npm test:*)');
    expect(ruleTexts(await localRules(tree.home, repo))).toEqual(['Bash(npm test:*)']);
  });

  it('applies a rule persisted at the repository root when the session starts in a nested subdirectory', async () => {
    const tree = makeTree();
    const repo = repository(tree.project);
    await persist(tree.home, repo, 'Bash(npm test:*)');
    expect(ruleTexts(await localRules(tree.home, path.join(repo, 'sub', 'deeper')))).toEqual(['Bash(npm test:*)']);
  });

  it('writes one file for every launch directory of the same repository', async () => {
    const tree = makeTree();
    const repo = repository(tree.project);
    await persist(tree.home, repo, 'Bash(npm test:*)');
    await persist(tree.home, path.join(repo, 'sub'), 'Bash(npm run lint:*)');
    expect(fs.readdirSync(path.join(tree.home, '.momonga', 'projects'))).toHaveLength(1);
  });

  it('never shares grants between two different repositories', async () => {
    const tree = makeTree();
    const first = repository(tree.project);
    const second = repository(path.join(makeDir(), 'other'));
    await persist(tree.home, first, 'Bash(npm test:*)');
    expect(await localRules(tree.home, second)).toEqual([]);
  });

  it('keeps a separate grant set for a linked git worktree of the same repository', async () => {
    const tree = makeTree();
    const repo = repository(tree.project);
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'base');
    const linked = path.join(makeDir(), 'linked');
    git(repo, 'worktree', 'add', '-q', linked);
    await persist(tree.home, repo, 'Bash(npm test:*)');
    expect(await localRules(tree.home, linked)).toEqual([]);
    expect(ruleTexts(await localRules(tree.home, repo))).toEqual(['Bash(npm test:*)']);
  });

  it('keys a directory outside any repository on the launch directory itself', async () => {
    const tree = makeTree();
    fs.mkdirSync(path.join(tree.project, 'sub'), { mode: 0o700 });
    await persist(tree.home, path.join(tree.project, 'sub'), 'Bash(npm test:*)');
    expect(await localRules(tree.home, tree.project)).toEqual([]);
    expect(ruleTexts(await localRules(tree.home, path.join(tree.project, 'sub')))).toEqual(['Bash(npm test:*)']);
  });

  it('re-roots a path rule persisted from a subdirectory so it still names the same files', async () => {
    const tree = makeTree();
    const repo = repository(tree.project);
    await persist(tree.home, path.join(repo, 'sub'), 'Edit(./generated/**)');
    const [rule] = await localRules(tree.home, repo);
    expect(rule).toBeDefined();
    const specifier = rule?.specifier ?? '';
    expect(specifier.startsWith('./')).toBe(true);
    expect(path.resolve(rule?.settingsRoot ?? '', specifier)).toBe(path.join(fs.realpathSync(repo), 'sub', 'generated', '**'));
  });
});
