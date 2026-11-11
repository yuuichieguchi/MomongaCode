import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, protectedSetFor } from '@momonga/foundation';
import type { ProtectedSet } from '@momonga/foundation';
import { buildSeatbeltProfile, createBubblewrapSandbox, createPlaceholderJournal, createSeatbeltSandbox, heldMountPoints, planBubblewrap, nodeFilesystemPort } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, fakePolicyFilesystem, killGroupsForCleanup, NEVER_CANCELLED, testPaths, testKernelLock } from '@momonga/testkit';
import { makeTempDir, run } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const KILL_GRACE_MS = 300;
const BASE_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

type Built = { roots: string[]; cwd: string };

const createHostSandbox = (options: { tmpRoot: string; killGraceMs: number }): Sandbox =>
  process.platform === 'darwin' ? createSeatbeltSandbox({ lock: testKernelLock(), ...options }) : createBubblewrapSandbox({ lock: testKernelLock(), ...options, journal: createPlaceholderJournal(`${options.tmpRoot}-journal`), holders: () => heldMountPoints() });

const admits = async (policy: SandboxPolicy, cwd: string): Promise<unknown> => (process.platform === 'darwin' ? await buildSeatbeltProfile(policy, {}, testPaths()) : await planBubblewrap(policy, { cwd }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock())));

const startRefusal = async (policy: SandboxPolicy, cwd: string): Promise<unknown> => {
  try {
    await admits(policy, cwd);
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

  const setOf = async (roots: readonly string[]): Promise<ProtectedSet> => protectedSetFor(roots, fakePolicyFilesystem());

  const sh = async (cwd: string, script: string, policy: SandboxPolicy) => {
    const proc = await sandbox.spawn({ argv: ['/bin/sh', '-c', script], cwd, env: BASE_ENV }, policy, new AbortController().signal);
    spawned.push(proc);
    return run(await proc);
  };

  const refusedWithControl = async (build: (base: string) => Built, script: string, unchanged: (cwd: string) => unknown) => {
    const protectedBase = tempDir();
    const target = build(protectedBase);
    const set = await setOf(target.roots);
    const policy = policyOf(target.roots, await set);
    const before = unchanged(target.cwd);
    const refusedToStart = await startRefusal(policy, target.cwd);
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

    const withModule = (base: string): Built => {
      const built = standalone(base);
      const module = path.join(built.cwd, '.git', 'modules', 'a');
      fs.mkdirSync(path.join(module, 'objects'), { recursive: true });
      fs.mkdirSync(path.join(module, 'refs'));
      fs.writeFileSync(path.join(module, 'HEAD'), 'ref: refs/heads/main\n');
      return built;
    };

    const withWorktree = (base: string): Built => {
      const built = standalone(base);
      const admin = path.join(built.cwd, '.git', 'worktrees', 'wt');
      fs.mkdirSync(admin, { recursive: true });
      fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/main\n');
      return built;
    };

    const write = (target: string): string => `mkdir -p "$(dirname ${target})" && printf x > ${target}`;

    const allowed = async (build: (base: string) => Built, target: string): Promise<void> => {
      const built = build(tempDir());
      const result = await sh(built.cwd, write(target), policyOf(built.roots, await setOf(built.roots)));
      expect(result.code).toBe(0);
      expect(fs.readFileSync(path.join(built.cwd, target), 'utf8')).toBe('x');
    };

    describe.runIf(process.platform === 'darwin')('Seatbelt: the profile regex covers paths that do not exist yet', () => {
      it.each([
        ['a new module hooks directory', standalone, '.git/modules/subm/hooks/x'],
        ['a new nested module config', standalone, '.git/modules/a/modules/b/config'],
        ['a new worktree config.worktree', standalone, '.git/worktrees/wt/config.worktree'],
        ['a config file below an existing module refs', withModule, '.git/modules/a/refs/heads/config'],
        ['a new hooks file in an existing module', withModule, '.git/modules/a/hooks/x'],
        ['a config.worktree of an existing worktree', withWorktree, '.git/worktrees/wt/config.worktree'],
      ] as const)('refuses %s', async (_label, build, target) => {
        await refusedWithControl(build, write(target), stateOf(target));
      });

      it.each([
        ['a new module objects file', standalone, '.git/modules/subm/objects/x'],
        ['an objects file of an existing module', withModule, '.git/modules/a/objects/x'],
        ['a worktree HEAD', standalone, '.git/worktrees/wt/HEAD'],
      ] as const)('allows %s', async (_label, build, target) => {
        await allowed(build, target);
      });
    });

    describe.runIf(process.platform === 'linux')('bubblewrap: the kernel can only pin what exists, so a read-only anchor stands for the pattern', () => {
      it.each([
        ['a new module (the whole child of the modules anchor)', standalone, '.git/modules/subm/hooks/x'],
        ['a new module objects file', standalone, '.git/modules/subm/objects/x'],
        ['a new nested module config', standalone, '.git/modules/a/modules/b/config'],
        ['a new module beside an existing one', withModule, '.git/modules/b/HEAD'],
        ['a hooks file of an existing module', withModule, '.git/modules/a/hooks/x'],
        ['a config file of an existing module', withModule, '.git/modules/a/config'],
        ['a config.worktree of an existing module', withModule, '.git/modules/a/config.worktree'],
        ['a module nested in an existing module', withModule, '.git/modules/a/modules/b/objects/x'],
        ['a config.worktree of an existing worktree', withWorktree, '.git/worktrees/wt/config.worktree'],
      ] as const)('refuses %s', async (_label, build, target) => {
        await refusedWithControl(build, write(target), stateOf(target));
      });

      it.each([
        ['an objects file of an existing module', withModule, '.git/modules/a/objects/x'],
        ['a ref of an existing module', withModule, '.git/modules/a/refs/heads/x'],
        ['a config file below the refs of an existing module, which git never adopts (nested-git-adoption.test.ts)', withModule, '.git/modules/a/refs/heads/config'],
        ['a worktree HEAD', standalone, '.git/worktrees/wt/HEAD'],
        ['a new worktree config.worktree, which git never adopts (nested-git-adoption.test.ts)', standalone, '.git/worktrees/wt/config.worktree'],
      ] as const)('allows %s', async (_label, build, target) => {
        await allowed(build, target);
      });

      describe('renaming the directory that holds a pinned file away (Linux allows renaming an ancestor of a mount point)', () => {
        const withWorktreeConfig = (base: string): Built => {
          const built = withWorktree(base);
          fs.writeFileSync(path.join(built.cwd, '.git', 'worktrees', 'wt', 'config.worktree'), '[core]\n');
          return built;
        };

        const withModuleWorktree = (base: string): Built => {
          const built = withModule(base);
          const admin = path.join(built.cwd, '.git', 'modules', 'a', 'worktrees', 't');
          fs.mkdirSync(admin, { recursive: true });
          fs.writeFileSync(path.join(admin, 'config.worktree'), '[core]\n');
          return built;
        };

        const swap = (directory: string): string =>
          `mv ${directory} ${directory}.old && mkdir ${directory} && printf '[core]\\n\\tfsmonitor = ./evil\\n' > ${directory}/config.worktree`;

        it.each([
          ['a worktree administrative directory', withWorktreeConfig, '.git/worktrees/wt'],
          ['a worktree administrative directory of a module', withModuleWorktree, '.git/modules/a/worktrees/t'],
        ] as const)('refuses to move %s away and put another with its own config.worktree in its place', async (_label, build, directory) => {
          await refusedWithControl(build, swap(directory), stateOf(`${directory}/config.worktree`, `${directory}.old`));
        });
      });

      it('plans a placeholder where the modules directory is missing, so no module can be created', async () => {
        const built = standalone(tempDir());
        fs.rmdirSync(path.join(built.cwd, '.git', 'modules'));
        const refused = await sh(built.cwd, 'mkdir .git/modules', policyOf(built.roots, await setOf(built.roots)));
        expect(refused.code).not.toBe(0);
        expect(fs.existsSync(path.join(built.cwd, '.git', 'modules'))).toBe(false);
      });
    });

    it('refuses a write below a missing-target directory', async () => {
      await refusedWithControl(pointing('gitdir: inner\n', () => undefined), 'mkdir -p inner/x && printf x > inner/x/y', stateOf('inner'));
    });

    it('builds a profile for a worktree whose main repository lies outside the roots', async () => {
      const base = tempDir();
      const built = worktreeBoth(base);
      const roots = [built.cwd];
      const policy = policyOf(roots, await setOf(roots));
      await expect((async () => { await await admits(policy, built.cwd); })()).resolves.toBeUndefined();
      const inside = await sh(built.cwd, 'printf x > inside.txt', policy);
      expect(inside.code).toBe(0);
      expect(fs.readFileSync(path.join(built.cwd, 'inside.txt'), 'utf8')).toBe('x');
      const hooks = await sh(built.cwd, 'printf x > ../main/.git/hooks/x', policy);
      expect(hooks.code).not.toBe(0);
      expect(fs.existsSync(path.join(base, 'main', '.git', 'hooks', 'x'))).toBe(false);
    });
  });
});
