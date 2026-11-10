import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { HOST_RULE_ENFORCEMENT, protectedSetFor } from '@momonga/foundation';
import { EMPTY_GLOB_TABLE, computeFileRules, createGlobDeadline, decide, parseRule, prepareGlobs, settleGlobs } from '@momonga/policy';
import type { Decision, GlobTable, PermissionRule, RuleEffect } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { TEST_SEARCH_PATH, isWritableFor } from '@momonga/testkit';
import { createPolicyFilesystem } from '@momonga/tools';

export const REAL_BASH = '/bin/bash';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

type DecideOptions = { mode?: PermissionMode; cwd?: string; searchPath?: string; rules?: ReadonlyArray<readonly [RuleEffect, string]> };

const GLOB_TEST_BUDGET_MS = 60_000;

export type RealWorkspace = {
  base: string;
  project: string;
  home: string;
  outside: string;
  write(relative: string, content: string, mode?: number): string;
  mkdir(relative: string): string;
  link(target: string, relative: string): string;
  exists(relative: string): boolean;
  read(relative: string): string;
  decide(command: string, options?: DecideOptions): Decision;
  decideExpanding(command: string, options?: DecideOptions): Promise<Decision>;
  runBash(command: string, cwd?: string, extra?: Record<string, string>): { stdout: string; stderr: string; status: number | null };
  env(extra?: Record<string, string>): NodeJS.ProcessEnv;
  git(cwd: string, ...args: string[]): { stdout: string; stderr: string; status: number | null };
  initRepository(relative?: string): string;
};

export const makeRealWorkspace = (): RealWorkspace => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-real-')));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  const home = path.join(base, 'home');
  const outside = path.join(base, 'outside');
  for (const dir of [project, home, outside]) fs.mkdirSync(dir, { mode: 0o700 });
  const filesystem = createPolicyFilesystem();
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    HOME: home,
    PATH: TEST_SEARCH_PATH,
    LANG: 'C',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  });
  const at = (relative: string): string => path.resolve(project, relative);
  const decideWith = (globs: GlobTable, command: string, options: DecideOptions): Decision => {
    const rules: PermissionRule[] = (options.rules ?? []).map(([effect, text]) =>
      parseRule(text, { effect, origin: 'user', source: 'user-settings', settingsRoot: project, home, cwd: project }),
    );
    const roots = [project];
    return decide({
      tool: { name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' },
      subject: { kind: 'command', tool: 'Bash', command },
      mode: options.mode ?? 'default',
      rules,
      roots,
      home,
      cwd: options.cwd ?? project,
      fileRules: computeFileRules(rules, roots, null, HOST_RULE_ENFORCEMENT),
      protectedSet: protectedSetFor(roots, filesystem),
      fs: settleGlobs(filesystem, globs),
      searchPath: options.searchPath ?? TEST_SEARCH_PATH,
      isWritable: isWritableFor(roots),
    });
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('/usr/bin/git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  };
  return {
    base,
    project,
    home,
    outside,
    write: (relative, content, mode = 0o600) => {
      const file = at(relative);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, content, { mode });
      return file;
    },
    mkdir: (relative) => {
      fs.mkdirSync(at(relative), { recursive: true, mode: 0o700 });
      return at(relative);
    },
    link: (target, relative) => {
      fs.mkdirSync(path.dirname(at(relative)), { recursive: true, mode: 0o700 });
      fs.symlinkSync(target, at(relative));
      return at(relative);
    },
    exists: (relative) => fs.existsSync(at(relative)),
    read: (relative) => fs.readFileSync(at(relative), 'utf8'),
    decide: (command, options = {}) => decideWith(EMPTY_GLOB_TABLE, command, options),
    decideExpanding: async (command, options = {}) => {
      const globs = await prepareGlobs({
        expand: filesystem.expandGlob,
        platform: filesystem.platform,
        subject: { kind: 'command', tool: 'Bash', command },
        cwd: options.cwd ?? project,
        home,
        deadline: createGlobDeadline(GLOB_TEST_BUDGET_MS),
        signal: new AbortController().signal,
      });
      return decideWith(globs, command, options);
    },
    runBash: (command, cwd = project, extra = {}) => {
      const result = spawnSync(REAL_BASH, ['-c', command], { cwd, env: env(extra), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { stdout: result.stdout, stderr: result.stderr, status: result.status };
    },
    env,
    git,
    initRepository: (relative = '.') => {
      const directory = at(relative);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 't'], ['config', 'user.email', 't@t']]) {
        const result = git(directory, ...args);
        if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      fs.writeFileSync(path.join(directory, 'tracked'), 'one\n');
      for (const args of [['add', 'tracked'], ['commit', '-q', '-m', 'one']]) {
        const result = git(directory, ...args);
        if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return directory;
    },
  };
};
