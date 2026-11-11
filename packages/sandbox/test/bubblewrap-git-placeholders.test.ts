import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, protectedSetFor } from '@momonga/foundation';
import { DEFAULT_BWRAP_PATH, createBubblewrapSandbox, createPlaceholderJournal, heldMountPoints } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, fakePolicyFilesystem, killGroupsForCleanup, waitFor } from '@momonga/testkit';
import { makeTempDir, run } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const KILL_GRACE_MS = 300;
const BASE_ENV = { PATH: '/usr/bin:/bin' };
const HAS_BWRAP = process.platform === 'linux' && fs.existsSync(DEFAULT_BWRAP_PATH);

describe.runIf(HAS_BWRAP)('git in a normal repository with bubblewrap placeholders (real bwrap)', () => {
  let created: string[] = [];
  let spawned: SandboxedProcess[] = [];
  let repo = '';
  let outside = '';
  let sandbox: Sandbox;

  const tempDir = (): string => {
    const dir = fs.realpathSync(makeTempDir());
    created.push(dir);
    return dir;
  };

  const gitEnv = (): Record<string, string> => ({ ...BASE_ENV, HOME: outside, GIT_CONFIG_NOSYSTEM: '1' });

  const hostGit = (...args: string[]) => spawnSync('git', args, { cwd: repo, env: gitEnv(), encoding: 'utf8' });

  const policy = async (): Promise<SandboxPolicy> => {
    const roots = [repo, outside];
    const protectedSet = await protectedSetFor(roots, fakePolicyFilesystem({ platform: 'linux' }));
    return {
      writableRoots: roots,
      writeDenied: [...protectedSet.paths],
      writeDeniedLiterals: [],
      readDenied: [],
      network: 'deny',
      fileRules: EMPTY_FILE_RULES,
      protectedSet,
    };
  };

  const sh = async (script: string, signal: AbortSignal = new AbortController().signal): Promise<SandboxedProcess> => {
    const proc = await sandbox.spawn({ argv: ['/bin/sh', '-c', script], cwd: repo, env: gitEnv() }, await policy(), signal);
    spawned.push(proc);
    return proc;
  };

  beforeEach(() => {
    repo = tempDir();
    outside = tempDir();
    sandbox = createBubblewrapSandbox({ tmpRoot: tempDir(), killGraceMs: KILL_GRACE_MS, journal: createPlaceholderJournal(path.join(tempDir(), 'journal')), holders: heldMountPoints });
    expect(hostGit('init', '-q').status).toBe(0);
    expect(hostGit('config', 'user.name', 'Momonga Test').status).toBe(0);
    expect(hostGit('config', 'user.email', 'momonga-test@example.invalid').status).toBe(0);
    fs.writeFileSync(path.join(repo, 'README'), 'hello\n');
    expect(hostGit('add', 'README').status).toBe(0);
    expect(hostGit('commit', '-q', '-m', 'initial').status).toBe(0);
    expect(fs.existsSync(path.join(repo, '.git', 'commondir'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.git', 'config.worktree'))).toBe(false);
  });

  afterEach(async () => {
    try {
      await killGroupsForCleanup(spawned.map((proc) => proc.pgid));
    } finally {
      for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
      created = [];
      spawned = [];
    }
  });

  it('runs git status and rev-parse inside the sandbox without a fatal error', async () => {
    const status = await run(await sh('git status --porcelain'));
    expect(status.stderr).not.toContain('fatal');
    expect(status.code).toBe(0);
    const commonDir = await run(await sh('git rev-parse --git-common-dir'));
    expect(commonDir.stderr).not.toContain('fatal');
    expect(commonDir.code).toBe(0);
    expect(fs.realpathSync(path.resolve(repo, commonDir.stdout.trim()))).toBe(fs.realpathSync(path.join(repo, '.git')));
  });

  it('shows the sandbox a commondir that holds a dot, and git status exits 0', async () => {
    const commondir = await run(await sh('cat .git/commondir'));
    expect(commondir.stdout).toBe('.\n');
    expect(commondir.code).toBe(0);
    const status = await run(await sh('git status --porcelain'));
    expect(status.stderr).toBe('');
    expect(status.code).toBe(0);
  });

  it('lets git status run on the host while a sandboxed command runs, and leaves no placeholder after release', async () => {
    const controller = new AbortController();
    const ready = path.join(outside, 'ready');
    const proc = await sh(`: > ${ready}; sleep 30`, controller.signal);
    await waitFor(() => fs.existsSync(ready), { description: 'the sandboxed command is running' });
    const status = hostGit('status', '--porcelain');
    expect(status.stderr).not.toContain('fatal');
    expect(status.status).toBe(0);
    controller.abort();
    await run(await proc);
    expect(fs.existsSync(path.join(repo, '.git', 'commondir'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.git', 'config.worktree'))).toBe(false);
  });
});

describe.runIf(HAS_BWRAP)('git in a root that is not a repository, inside a parent repository (real bwrap)', () => {
  let created: string[] = [];
  let spawned: SandboxedProcess[] = [];
  let parent = '';
  let child = '';
  let outside = '';
  let sandbox: Sandbox;

  const tempDir = (): string => {
    const dir = fs.realpathSync(makeTempDir());
    created.push(dir);
    return dir;
  };

  const gitEnv = (): Record<string, string> => ({ ...BASE_ENV, HOME: outside, GIT_CONFIG_NOSYSTEM: '1' });

  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' });

  const policy = async (): Promise<SandboxPolicy> => {
    const roots = [child, outside];
    const protectedSet = await protectedSetFor(roots, fakePolicyFilesystem({ platform: 'linux' }));
    return {
      writableRoots: roots,
      writeDenied: [...protectedSet.paths],
      writeDeniedLiterals: [],
      readDenied: [],
      network: 'deny',
      fileRules: EMPTY_FILE_RULES,
      protectedSet,
    };
  };

  const sh = async (script: string, signal: AbortSignal = new AbortController().signal): Promise<SandboxedProcess> => {
    const proc = await sandbox.spawn({ argv: ['/bin/sh', '-c', script], cwd: child, env: gitEnv() }, await policy(), signal);
    spawned.push(proc);
    return proc;
  };

  beforeEach(() => {
    parent = tempDir();
    outside = tempDir();
    child = path.join(parent, 'sub');
    fs.mkdirSync(child);
    sandbox = createBubblewrapSandbox({ tmpRoot: tempDir(), killGraceMs: KILL_GRACE_MS, journal: createPlaceholderJournal(path.join(tempDir(), 'journal')), holders: heldMountPoints });
    expect(git(parent, 'init', '-q').status).toBe(0);
    expect(fs.existsSync(path.join(child, '.git'))).toBe(false);
  });

  afterEach(async () => {
    try {
      await killGroupsForCleanup(spawned.map((proc) => proc.pgid));
    } finally {
      for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
      created = [];
      spawned = [];
    }
  });

  it('finds the parent top level inside the sandbox', async () => {
    const toplevel = await run(await sh('git rev-parse --show-toplevel'));
    expect(toplevel.stderr).not.toContain('invalid gitfile format');
    expect(toplevel.stderr).toBe('');
    expect(toplevel.code).toBe(0);
    expect(toplevel.stdout.trim()).toBe(parent);
  });

  it('finds the parent top level on the host while a sandboxed command runs, and leaves no .git in the root after release', async () => {
    const controller = new AbortController();
    const ready = path.join(outside, 'ready');
    const proc = await sh(`: > ${ready}; sleep 30`, controller.signal);
    await waitFor(() => fs.existsSync(ready), { description: 'the sandboxed command is running' });
    const toplevel = git(child, 'rev-parse', '--show-toplevel');
    expect(toplevel.stderr).not.toContain('invalid gitfile format');
    expect(toplevel.status).toBe(0);
    expect(toplevel.stdout.trim()).toBe(parent);
    controller.abort();
    await run(await proc);
    expect(fs.existsSync(path.join(child, '.git'))).toBe(false);
  });
});
