import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, protectedSetFor } from '@momonga/foundation';
import type { ProtectedSet } from '@momonga/foundation';
import { buildSeatbeltProfile, createBubblewrapSandbox, createSeatbeltSandbox, planBubblewrap } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { fakePolicyFilesystem, killGroupsForCleanup } from '@momonga/testkit';
import { makeTempDir, run } from './helpers.ts';

const KILL_GRACE_MS = 300;
const BASE_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

type Built = { roots: string[]; cwd: string };

const createHostSandbox = (options: { tmpRoot: string; killGraceMs: number }): Sandbox =>
  process.platform === 'darwin' ? createSeatbeltSandbox(options) : createBubblewrapSandbox(options);

const admits = (policy: SandboxPolicy, cwd: string): unknown => (process.platform === 'darwin' ? buildSeatbeltProfile(policy) : planBubblewrap(policy, { cwd }));

const startRefusal = (policy: SandboxPolicy, cwd: string): unknown => {
  try {
    admits(policy, cwd);
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('protected set in the kernel (real sandbox-exec on Darwin, real bwrap on Linux, 5.13)', () => {
  let created: string[] = [];
  let unlock: string[] = [];
  let spawned: SandboxedProcess[] = [];
  let sandbox: Sandbox;

  const tempDir = (): string => {
    const dir = fs.realpathSync(makeTempDir());
    created.push(dir);
    return dir;
  };

  const lockDirectory = (dir: string): void => {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o000);
    unlock.push(dir);
  };

  const policyOf = (roots: readonly string[], protectedSet: ProtectedSet): SandboxPolicy => ({
    writableRoots: [...roots],
    writeDenied: [...protectedSet.paths],
    writeDeniedLiterals: [],
    readDenied: [],
    network: 'deny',
    fileRules: EMPTY_FILE_RULES,
    protectedSet,
  });

  const setOf = (roots: readonly string[]): ProtectedSet => protectedSetFor(roots, fakePolicyFilesystem());

  const sh = async (cwd: string, script: string, policy: SandboxPolicy) => {
    const proc = sandbox.spawn({ argv: ['/bin/sh', '-c', script], cwd, env: BASE_ENV }, policy, new AbortController().signal);
    spawned.push(proc);
    return run(proc);
  };

  const refusedWithControl = async (build: (base: string) => Built, script: string, unchanged: (cwd: string) => unknown) => {
    const protectedBase = tempDir();
    const target = build(protectedBase);
    const set = setOf(target.roots);
    const policy = policyOf(target.roots, set);
    const before = unchanged(target.cwd);
    const refusedToStart = startRefusal(policy, target.cwd);
    if (refusedToStart === undefined) {
      const refused = await sh(target.cwd, script, policy);
      expect(refused.code).not.toBe(0);
    } else {
      expect(process.platform).not.toBe('darwin');
      expect(refusedToStart).toMatchObject({ name: 'SandboxPolicyError', code: 'protected_link_not_pinnable' });
    }
    expect(unchanged(target.cwd)).toEqual(before);

    const control = build(tempDir());
    const controlBefore = unchanged(control.cwd);
    const allowed = await sh(control.cwd, script, policyOf(control.roots, EMPTY_PROTECTED_SET));
    expect(allowed.code).toBe(0);
    expect(unchanged(control.cwd)).not.toEqual(controlBefore);
  };

  const describeEntry = (target: string): string => {
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) return `link:${fs.readlinkSync(target)}`;
      return `${stat.isDirectory() ? 'dir' : 'file'}:${(stat.mode & 0o777).toString(8)}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  };

  const stateOf = (...names: string[]) => (cwd: string) => names.map((name) => `${name}=${describeEntry(path.join(cwd, name))}`).join(' ');

  beforeEach(() => {
    sandbox = createHostSandbox({ tmpRoot: tempDir(), killGraceMs: KILL_GRACE_MS });
  });

  afterEach(async () => {
    try {
      await killGroupsForCleanup(spawned.map((proc) => proc.pgid));
    } finally {
      for (const dir of unlock) if (fs.existsSync(dir)) fs.chmodSync(dir, 0o700);
      for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
      created = [];
      unlock = [];
      spawned = [];
    }
  });

  const pointing = (text: string, prepare: (root: string) => void) => (base: string): Built => {
    const root = path.join(base, 'root');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, '.git'), text);
    prepare(root);
    return { roots: [root], cwd: root };
  };

  describe('case (ii) obstacles are pinned', () => {
    const regularFile = pointing('gitdir: x/y\n', (root) => fs.writeFileSync(path.join(root, 'x'), 'file'));
    const loop = pointing('gitdir: x/y\n', (root) => fs.symlinkSync('x', path.join(root, 'x')));
    const lockedX = pointing('gitdir: x/y\n', (root) => lockDirectory(path.join(root, 'x')));
    const twoLinks = pointing('gitdir: a/y\n', (root) => {
      fs.symlinkSync('b', path.join(root, 'a'));
      fs.symlinkSync('a', path.join(root, 'b'));
      fs.mkdirSync(path.join(root, 'dir'));
    });
    const linkToFile = pointing('gitdir: sf/y\n', (root) => {
      fs.writeFileSync(path.join(root, 'f'), 'file');
      fs.symlinkSync('f', path.join(root, 'sf'));
    });
    const linkToLocked = pointing('gitdir: a/l/y\n', (root) => {
      fs.mkdirSync(path.join(root, 'a'));
      fs.symlinkSync('../locked/z', path.join(root, 'a', 'l'));
      fs.mkdirSync(path.join(root, 'other'));
      lockDirectory(path.join(root, 'locked'));
    });

    it.each([
      ['a regular file: rm x', regularFile, 'rm x', ['x']],
      ['a regular file: mv x z', regularFile, 'mv x z', ['x', 'z']],
      ['a one-link loop: rm x', loop, 'rm x', ['x']],
      ['a one-link loop: ln -sfn other x', loop, 'mkdir other && ln -sfn other x', ['x']],
      ['a mode 000 directory: chmod 755 x', lockedX, 'chmod 755 x', ['x']],
      ['a mode 000 directory: rmdir x', lockedX, 'rmdir x', ['x']],
      ['a two-link loop: ln -sfn dir b', twoLinks, 'ln -sfn dir b', ['a', 'b']],
      ['a two-link loop: rm b', twoLinks, 'rm b', ['a', 'b']],
      ['a link to a file: rm f', linkToFile, 'rm f', ['sf', 'f']],
      ['a link to a file: rm f && mkdir f', linkToFile, 'rm f && mkdir f', ['sf', 'f']],
      ['a link to a locked directory: chmod 755 locked', linkToLocked, 'chmod 755 locked', ['a/l', 'locked']],
      ['a link to a locked directory: ln -sfn other a/l', linkToLocked, 'ln -sfn ../other a/l', ['a/l', 'locked']],
    ] as const)('refuses %s', async (_label, build, script, names) => {
      await refusedWithControl(build, script, stateOf(...names));
    });
  });

  describe('a .git file and the nested git directories', () => {
    const worktreeBoth = (base: string): Built => {
      const main = path.join(base, 'main');
      const gitDir = path.join(main, '.git', 'worktrees', 'wt');
      fs.mkdirSync(path.join(main, '.git', 'hooks'), { recursive: true });
      fs.mkdirSync(gitDir, { recursive: true });
      fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
      const wt = path.join(base, 'wt');
      fs.mkdirSync(wt);
      fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);
      return { roots: [wt, main], cwd: wt };
    };

    it('builds a profile for a root whose .git is a file and refuses a write to the common hooks', async () => {
      await refusedWithControl(worktreeBoth, 'printf x > ../main/.git/hooks/x', stateOf('../main/.git/hooks/x'));
    });

    it('refuses a write to the pointer file', async () => {
      await refusedWithControl(worktreeBoth, 'printf x > .git', (cwd) => fs.readFileSync(path.join(cwd, '.git'), 'utf8'));
    });

    const standalone = (base: string): Built => {
      const root = path.join(base, 'root');
      fs.mkdirSync(path.join(root, '.git', 'modules'), { recursive: true });
      fs.mkdirSync(path.join(root, '.git', 'worktrees'), { recursive: true });
      return { roots: [root], cwd: root };
    };

    it.each(['.git/modules/subm/hooks/x', '.git/modules/a/modules/b/config', '.git/worktrees/wt/config.worktree', '.git/modules/a/refs/heads/config'])(
      'refuses a write to %s',
      async (target) => {
        await refusedWithControl(standalone, `mkdir -p "$(dirname ${target})" && printf x > ${target}`, stateOf(target));
      },
    );

    it.each(['.git/modules/subm/objects/x', '.git/worktrees/wt/HEAD'])('allows a write to %s', async (target) => {
      const built = standalone(tempDir());
      const result = await sh(built.cwd, `mkdir -p "$(dirname ${target})" && printf x > ${target}`, policyOf(built.roots, setOf(built.roots)));
      expect(result.code).toBe(0);
      expect(fs.readFileSync(path.join(built.cwd, target), 'utf8')).toBe('x');
    });

    it('refuses a write below a missing-target directory', async () => {
      await refusedWithControl(pointing('gitdir: inner\n', () => undefined), 'mkdir -p inner/x && printf x > inner/x/y', stateOf('inner'));
    });

    it('builds a profile for a worktree whose main repository lies outside the roots', async () => {
      const base = tempDir();
      const built = worktreeBoth(base);
      const roots = [built.cwd];
      const policy = policyOf(roots, setOf(roots));
      expect(() => admits(policy, built.cwd)).not.toThrow();
      const inside = await sh(built.cwd, 'printf x > inside.txt', policy);
      expect(inside.code).toBe(0);
      expect(fs.readFileSync(path.join(built.cwd, 'inside.txt'), 'utf8')).toBe('x');
      const hooks = await sh(built.cwd, 'printf x > ../main/.git/hooks/x', policy);
      expect(hooks.code).not.toBe(0);
      expect(fs.existsSync(path.join(base, 'main', '.git', 'hooks', 'x'))).toBe(false);
    });
  });
});
