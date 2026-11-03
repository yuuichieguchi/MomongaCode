import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HOST_RULE_ENFORCEMENT, isProtectedWrite, protectedSetFor } from '@momonga/foundation';
import type { ProtectedSet } from '@momonga/foundation';
import { EMPTY_GLOB_TABLE, computeFileRules, decide, settleGlobs } from '@momonga/policy';
import type { SandboxedProcess } from '@momonga/sandbox';
import { TEST_SEARCH_PATH, isWritableFor } from '@momonga/testkit';
import { buildSandboxPolicy, createPolicyFilesystem } from '@momonga/tools';
import { createHostSandbox } from './helpers.ts';

const SYSTEM_GIT = '/usr/bin/git';
const SEARCH_PATH = '/usr/bin:/bin';

let root = '';
let gitEnv: NodeJS.ProcessEnv = {};

const git = (cwd: string, ...args: string[]) => spawnSync(SYSTEM_GIT, args, { cwd, env: gitEnv, encoding: 'utf8' });

const gitOk = (cwd: string, ...args: string[]): string => {
  const result = git(cwd, ...args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
};

const canonicalOf = (target: string): string => path.join(fs.realpathSync.native(path.dirname(target)), path.basename(target));

const gitPath = (cwd: string, key: string): string => canonicalOf(path.resolve(cwd, gitOk(cwd, 'rev-parse', '--git-path', key)));

const policyFilesystem = () => createPolicyFilesystem();

const setFor = (repositoryRoot: string): ProtectedSet => protectedSetFor([repositoryRoot], policyFilesystem());

const probes = () => {
  const filesystem = policyFilesystem();
  return { canonicalise: filesystem.canonicalise, volumeProbe: filesystem.volumeProbe };
};

const hook = (file: string, marker: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
};

const commitIn = (cwd: string, name: string): void => {
  fs.writeFileSync(path.join(cwd, name), name);
  gitOk(cwd, 'add', name);
  gitOk(cwd, 'commit', '-q', '-m', name);
};

const collect = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

const finish = async (proc: SandboxedProcess) => {
  const [stdout, stderr, exit] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]);
  return { stdout, stderr, code: exit.code };
};

describe('real git: a linked worktree, a submodule and the missing-target sequence (5.13)', () => {
  let main = '';
  let worktree = '';
  let submodule = '';

  beforeAll(() => {
    if (!fs.existsSync(SYSTEM_GIT)) throw new Error(`system git required at ${SYSTEM_GIT}`);
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-git-')));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    gitEnv = {
      HOME: home,
      PATH: SEARCH_PATH,
      LANG: 'C',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    main = path.join(root, 'main');
    worktree = path.join(root, 'wt');
    const sub = path.join(root, 'sub');
    gitOk(root, 'init', '-q', '-b', 'main', 'main');
    commitIn(main, 'a.txt');
    gitOk(root, 'init', '-q', '-b', 'main', 'sub');
    commitIn(sub, 's.txt');
    gitOk(main, 'worktree', 'add', '-q', '../wt', '-b', 'b2');
    gitOk(main, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', '../sub', 'subm');
    submodule = path.join(main, 'subm');
  });

  afterAll(() => {
    if (root !== '') fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['worktree', 'submodule'] as const)('protects the hooks, config and config.worktree paths git reports for the %s', (which) => {
    const repositoryRoot = which === 'worktree' ? worktree : submodule;
    const set = setFor(repositoryRoot);
    expect(set.issues).toEqual([]);
    for (const key of ['hooks', 'config', 'config.worktree']) {
      expect(set.paths).toContain(gitPath(repositoryRoot, key));
    }
    expect(set.paths).toContain(path.join(repositoryRoot, '.git'));
  });

  it.each(['worktree', 'submodule'] as const)('reads the %s pointer as git does', (which) => {
    const repositoryRoot = which === 'worktree' ? worktree : submodule;
    const entry = policyFilesystem().readEntry(path.join(repositoryRoot, '.git'));
    if (!('kind' in entry) || entry.kind !== 'file') throw new Error('expected a file entry');
    const text = entry.text.replace(/\r?\n$/, '');
    expect(text.startsWith('gitdir: ')).toBe(true);
    const gitDir = fs.realpathSync.native(path.resolve(repositoryRoot, text.slice('gitdir: '.length)));
    expect(gitDir).toBe(fs.realpathSync.native(path.resolve(repositoryRoot, gitOk(repositoryRoot, 'rev-parse', '--git-dir'))));
    const commonDir = fs.realpathSync.native(path.resolve(repositoryRoot, gitOk(repositoryRoot, 'rev-parse', '--git-common-dir')));
    const set = setFor(repositoryRoot);
    expect(set.paths).toEqual(expect.arrayContaining([path.join(commonDir, 'hooks'), path.join(commonDir, 'config'), path.join(gitDir, 'config.worktree')]));
  });

  it('runs a hook in the protected hooks path on commit in the worktree and not one in the worktree git dir', () => {
    const commonHooks = gitPath(worktree, 'hooks');
    const gitDir = fs.realpathSync.native(path.resolve(worktree, gitOk(worktree, 'rev-parse', '--git-dir')));
    const ran = path.join(root, 'common-hook-ran');
    const notRan = path.join(root, 'worktree-hook-ran');
    hook(path.join(commonHooks, 'pre-commit'), ran);
    hook(path.join(gitDir, 'hooks', 'pre-commit'), notRan);
    try {
      commitIn(worktree, 'w.txt');
      expect(fs.existsSync(ran)).toBe(true);
      expect(fs.existsSync(notRan)).toBe(false);
      expect(setFor(worktree).paths).toContain(commonHooks);
      expect(setFor(worktree).paths).not.toContain(path.join(gitDir, 'hooks'));
    } finally {
      fs.rmSync(path.join(commonHooks, 'pre-commit'), { force: true });
    }
  });

  it('runs a hook in the protected hooks path of the submodule on commit', () => {
    const hooks = gitPath(submodule, 'hooks');
    const ran = path.join(root, 'submodule-hook-ran');
    hook(path.join(hooks, 'pre-commit'), ran);
    try {
      commitIn(submodule, 'm.txt');
      expect(fs.existsSync(ran)).toBe(true);
      expect(setFor(submodule).paths).toContain(hooks);
    } finally {
      fs.rmSync(path.join(hooks, 'pre-commit'), { force: true });
    }
  });

  it.each([
    ['trailing spaces', '../..  \n', false],
    ['a second line', '../..\nsecond\n', false],
    ['CRLF', '../..\r\n', true],
  ] as const)('treats a commondir with %s as git does', (_label, text, gitWorks) => {
    const gitDir = fs.realpathSync.native(path.resolve(worktree, gitOk(worktree, 'rev-parse', '--git-dir')));
    const commondir = path.join(gitDir, 'commondir');
    const original = fs.readFileSync(commondir, 'utf8');
    fs.writeFileSync(commondir, text);
    try {
      expect(git(worktree, 'status', '--porcelain').status === 0).toBe(gitWorks);
      const set = setFor(worktree);
      if (gitWorks) {
        expect(set.issues).toEqual([]);
      } else {
        expect(set.issues).toEqual([{ root: worktree, file: commondir, problem: 'missing-target' }]);
      }
    } finally {
      fs.writeFileSync(commondir, original);
    }
  });

  describe('the missing-target sequence', () => {
    let repositoryRoot = '';
    let set: ProtectedSet = undefined as unknown as ProtectedSet;

    beforeAll(() => {
      repositoryRoot = path.join(root, 'seq');
      fs.mkdirSync(repositoryRoot);
      fs.writeFileSync(path.join(repositoryRoot, '.git'), 'gitdir: inner\n');
    });

    it('fails git status with 128 and reports missing-target', () => {
      expect(git(repositoryRoot, 'status').status).toBe(128);
      set = setFor(repositoryRoot);
      expect(set.issues).toEqual([{ root: repositoryRoot, file: path.join(repositoryRoot, '.git'), problem: 'missing-target' }]);
    });

    it('protects inner/config before inner exists, for approval and in the kernel', async () => {
      set = setFor(repositoryRoot);
      const innerConfig = path.join(repositoryRoot, 'inner', 'config');
      expect(isProtectedWrite(set, innerConfig, probes())).toBe(true);
      const decision = decide({
        tool: { name: 'Write', kind: 'edit', sideEffect: 'write', subjectKind: 'path' },
        subject: { kind: 'path', tool: 'Write', paths: [innerConfig], access: 'write' },
        mode: 'default',
        rules: [],
        roots: [repositoryRoot],
        home: path.join(root, 'home'),
        cwd: repositoryRoot,
        fileRules: computeFileRules([], [repositoryRoot], null, HOST_RULE_ENFORCEMENT),
        fs: settleGlobs(policyFilesystem(), EMPTY_GLOB_TABLE), searchPath: TEST_SEARCH_PATH, isWritable: isWritableFor([repositoryRoot]),
        protectedSet: set,
      });
      expect(decision).toMatchObject({ kind: 'ask', source: 'protected' });

      const sessions = path.join(root, 'sessions');
      const tmpDir = path.join(sessions, 'one');
      fs.mkdirSync(tmpDir, { recursive: true });
      const sandboxTmp = path.join(root, 'sandbox-tmp');
      fs.mkdirSync(sandboxTmp, { recursive: true });
      const policy = buildSandboxPolicy({
        roots: [repositoryRoot],
        home: path.join(root, 'home'),
        tmpDir,
        sessionsTmpRoot: sessions,
        fileRules: computeFileRules([], [repositoryRoot], tmpDir, HOST_RULE_ENFORCEMENT),
        protectedSet: set,
      });
      const sandbox = createHostSandbox({ tmpRoot: sandboxTmp, killGraceMs: 300 });
      const result = await finish(
        sandbox.spawn(
          { argv: ['/bin/sh', '-c', 'mkdir -p inner && printf "[core]\\n\\tfsmonitor = touch MARKER\\n" > inner/config'], cwd: repositoryRoot, env: { PATH: SEARCH_PATH } },
          policy,
          new AbortController().signal,
        ),
      );
      expect(result.code).not.toBe(0);
      expect(fs.existsSync(innerConfig)).toBe(false);
    });

    it('control: without the protection the planted repository runs core.fsmonitor on git status', () => {
      const control = path.join(root, 'control');
      fs.mkdirSync(control);
      fs.writeFileSync(path.join(control, '.git'), 'gitdir: inner\n');
      gitOk(control, 'init', '-q', '--bare', 'inner');
      gitOk(control, '--git-dir=inner', 'config', 'core.bare', 'false');
      gitOk(control, '--git-dir=inner', 'config', 'core.fsmonitor', 'touch MARKER');
      git(control, 'status');
      expect(fs.existsSync(path.join(control, 'MARKER'))).toBe(true);
    });
  });

  describe('a .git the kernel must pin (V14, P2-7)', () => {
    const sandboxed = async (repositoryRoot: string, script: string) => {
      const sessions = path.join(root, `sessions-${path.basename(repositoryRoot)}`);
      const tmpDir = path.join(sessions, 'one');
      fs.mkdirSync(tmpDir, { recursive: true });
      const sandboxTmp = path.join(root, `sandbox-${path.basename(repositoryRoot)}`);
      fs.mkdirSync(sandboxTmp, { recursive: true });
      const policy = buildSandboxPolicy({
        roots: [repositoryRoot],
        home: path.join(root, 'home'),
        tmpDir,
        sessionsTmpRoot: sessions,
        fileRules: computeFileRules([], [repositoryRoot], tmpDir, HOST_RULE_ENFORCEMENT),
        protectedSet: setFor(repositoryRoot),
      });
      const sandbox = createHostSandbox({ tmpRoot: sandboxTmp, killGraceMs: 300 });
      return finish(sandbox.spawn({ argv: ['/bin/sh', '-c', script], cwd: repositoryRoot, env: { PATH: SEARCH_PATH } }, policy, new AbortController().signal));
    };

    const refusedByKernel = async (repositoryRoot: string, script: string): Promise<void> => {
      if (process.platform === 'darwin') {
        expect((await sandboxed(repositoryRoot, script)).code).not.toBe(0);
        return;
      }
      await expect(sandboxed(repositoryRoot, script)).rejects.toMatchObject({ name: 'SandboxPolicyError', code: 'protected_link_not_pinnable' });
    };

    it('builds a policy for .git -> .git and refuses removing the link', async () => {
      const repositoryRoot = path.join(root, 'loop');
      fs.mkdirSync(repositoryRoot);
      fs.symlinkSync('.git', path.join(repositoryRoot, '.git'));
      await refusedByKernel(repositoryRoot, 'rm .git');
      expect(fs.lstatSync(path.join(repositoryRoot, '.git')).isSymbolicLink()).toBe(true);
    });

    it('builds a policy for .git -> locked/z with locked at mode 000', async () => {
      const repositoryRoot = path.join(root, 'lock');
      const locked = path.join(repositoryRoot, 'locked');
      fs.mkdirSync(locked, { recursive: true });
      fs.chmodSync(locked, 0o000);
      fs.symlinkSync('locked/z', path.join(repositoryRoot, '.git'));
      try {
        await refusedByKernel(repositoryRoot, 'rm .git');
        expect(fs.lstatSync(path.join(repositoryRoot, '.git')).isSymbolicLink()).toBe(true);
      } finally {
        fs.chmodSync(locked, 0o700);
      }
    });

    it('builds a policy for a .git file at mode 000 and protects the pointer without throwing', async () => {
      const repositoryRoot = path.join(root, 'unreadable-pointer');
      fs.mkdirSync(repositoryRoot);
      const pointer = path.join(repositoryRoot, '.git');
      fs.writeFileSync(pointer, 'gitdir: elsewhere\n');
      fs.chmodSync(pointer, 0o000);
      try {
        const set = setFor(repositoryRoot);
        expect(set.issues).toMatchObject([{ root: repositoryRoot, file: pointer, problem: 'unresolvable' }]);
        expect(isProtectedWrite(set, pointer, probes())).toBe(true);
        expect((await sandboxed(repositoryRoot, 'rm .git')).code).not.toBe(0);
        expect(fs.existsSync(pointer)).toBe(true);
      } finally {
        fs.chmodSync(pointer, 0o600);
      }
    });

    it.each([
      ['replacing', 'rm .git && mkdir -p .git/hooks && echo x > .git/hooks/pre-commit'],
      ['re-pointing', 'mkdir other && ln -sfn other .git'],
    ])('refuses %s a .git -> realgit link', async (label, script) => {
      const repositoryRoot = path.join(root, `linked-${label}`);
      fs.mkdirSync(path.join(repositoryRoot, 'realgit', 'hooks'), { recursive: true });
      fs.symlinkSync('realgit', path.join(repositoryRoot, '.git'));
      await refusedByKernel(repositoryRoot, script);
      expect(fs.readlinkSync(path.join(repositoryRoot, '.git'))).toBe('realgit');
    });
  });
});
