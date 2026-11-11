import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import type { FileRuleSet } from '@momonga/foundation';
import { SandboxPolicyError, nodeFilesystemPort, planBubblewrap } from '@momonga/sandbox';
import type { FilesystemPort, SandboxPolicy } from '@momonga/sandbox';
import { fileRulesOf, fileSpec } from './file-rule-specs.ts';
import { makeTempDir } from './helpers.ts';
import { NEVER_CANCELLED, testKernelLock } from '@momonga/testkit';

let base = '';
let work = '';
let home = '';
let secrets = '';
let sessions = '';
let mine = '';

beforeEach(() => {
  base = fs.realpathSync(makeTempDir());
  work = path.join(base, 'work');
  home = path.join(base, 'home');
  secrets = path.join(home, '.momonga');
  sessions = path.join(base, 'sessions');
  mine = path.join(sessions, 's1');
  for (const dir of [work, home, secrets, mine]) fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const policy = (overrides: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  writableRoots: [work],
  writeDenied: [],
  writeDeniedLiterals: [],
  protectedSet: EMPTY_PROTECTED_SET,
  fileRules: EMPTY_FILE_RULES,
  readDenied: [],
  network: 'deny',
  ...overrides,
});

const indexOfTriple = (args: readonly string[], flag: string, source: string, dest = source): number =>
  args.findIndex((value, index) => value === flag && args[index + 1] === source && args[index + 2] === dest);

const FILE_RULES = async (specs: ReturnType<typeof fileSpec>[]): Promise<FileRuleSet> => fileRulesOf(specs, [work]);

describe('planBubblewrap refuses a protected name that is a symlink (review item 7)', () => {
  const refusal = async (literal: string) => {
    try {
      await planBubblewrap(policy({ writeDeniedLiterals: [literal] }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it('refuses .git -> realgit with a SandboxPolicyError that names the path, because a mount cannot sit on a link name', async () => {
    fs.mkdirSync(path.join(work, 'realgit'));
    fs.symlinkSync('realgit', path.join(work, '.git'));
    const error = await refusal(path.join(work, '.git'));
    expect(error).toBeInstanceOf(SandboxPolicyError);
    expect(error).toMatchObject({ code: 'protected_link_not_pinnable', path: path.join(work, '.git') });
    expect((error as SandboxPolicyError).message).toContain(path.join(work, '.git'));
  });

  it('refuses a symlink loop at .git the same way instead of throwing a raw ELOOP', async () => {
    fs.symlinkSync('.git', path.join(work, '.git'));
    const error = await refusal(path.join(work, '.git'));
    expect(error).toBeInstanceOf(SandboxPolicyError);
    expect(error).toMatchObject({ code: 'protected_link_not_pinnable', path: path.join(work, '.git') });
  });

  it('refuses an entry that cannot be inspected because a loop lies in the way, naming it', async () => {
    fs.symlinkSync('loop', path.join(work, 'loop'));
    const target = path.join(work, 'loop', 'inner');
    const error = await refusal(target);
    expect(error).toBeInstanceOf(SandboxPolicyError);
    expect(error).toMatchObject({ code: 'protected_path_unreadable', path: target });
    expect((error as SandboxPolicyError).message).toContain(target);
  });

  it('refuses an entry below a directory of mode 000, naming it', async () => {
    if (process.getuid?.() === 0) return;
    const locked = path.join(work, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      const target = path.join(locked, 'inner');
      const error = await refusal(target);
      expect(error).toBeInstanceOf(SandboxPolicyError);
      expect(error).toMatchObject({ code: 'protected_path_unreadable', path: target });
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it('control: a regular file or a directory at the protected name is still pinned', async () => {
    fs.mkdirSync(path.join(work, '.git'));
    const { args } = await planBubblewrap(policy({ writeDeniedLiterals: [path.join(work, '.git')] }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    expect(indexOfTriple(args, '--ro-bind', path.join(work, '.git'))).toBeGreaterThan(-1);
  });
});

describe('planBubblewrap refuses only where the sandboxed process could change what it protects', () => {
  const unlessRoot = (): boolean => process.getuid?.() === 0;

  it('does not refuse a symlinked write-denied literal outside every writable area: the read-only root already holds it', async () => {
    const launcher = path.join(home, 'momonga');
    fs.symlinkSync('target', launcher);
    const { args } = await planBubblewrap(policy({ writeDeniedLiterals: [launcher] }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    expect(indexOfTriple(args, '--ro-bind', launcher)).toBe(-1);
  });

  it('treats EACCES outside every writable area as absent', async () => {
    if (unlessRoot()) return;
    const locked = path.join(base, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      const target = path.join(locked, 'secret');
      await expect((async () => { await await planBubblewrap(policy({ writeDeniedLiterals: [target] }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock())); })()).resolves.toBeUndefined();
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it('refuses EACCES on a protected literal inside a writable area', async () => {
    if (unlessRoot()) return;
    const locked = path.join(work, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      const target = path.join(locked, 'secret');
      await expect(planBubblewrap(policy({ writeDeniedLiterals: [target] }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()))).rejects.toThrowError(expect.objectContaining({ code: 'protected_path_unreadable', path: target }));
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it('refuses an unreachable ancestor of a writable root, and ignores an unreachable path elsewhere', async () => {
    const elsewhere = path.join(sessions, 'x');
    const port: FilesystemPort = { ...nodeFilesystemPort(testKernelLock()), kindOf: (target) => (target === base || target === elsewhere ? 'unreachable' : nodeFilesystemPort(testKernelLock()).kindOf(target)) };
    await expect(planBubblewrap(policy({ writeDeniedLiterals: [base] }), { cwd: work }, NEVER_CANCELLED, port)).rejects.toThrowError(expect.objectContaining({ code: 'protected_path_unreadable', path: base }));
    await expect((async () => { await await planBubblewrap(policy({ writeDeniedLiterals: [elsewhere] }), { cwd: work }, NEVER_CANCELLED, port); })()).resolves.toBeUndefined();
  });

  it('applies the same rule to a directory that cannot be listed while a deny pattern expands', async () => {
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const unlistable: FilesystemPort = { ...nodeFilesystemPort(testKernelLock()), children: () => 'unreachable' };
    const outsideRules = await fileRulesOf([fileSpec('**/.env', { roots: [elsewhere], home, tool: 'Read' })], [elsewhere]);
    await expect((async () => { await await planBubblewrap(policy({ fileRules: await outsideRules }), { cwd: work }, NEVER_CANCELLED, unlistable); })()).resolves.toBeUndefined();
    const insideRules = await FILE_RULES([fileSpec('**/.env', { roots: [work], home, tool: 'Read' })]);
    await expect(planBubblewrap(policy({ fileRules: await insideRules }), { cwd: work }, NEVER_CANCELLED, unlistable)).rejects.toThrowError(expect.objectContaining({ code: 'protected_path_unreadable', path: work }));
  });
});

describe('planBubblewrap', () => {
  it('starts from a read-only view of the host with devices, a private proc and a masked /run', async () => {
    const { args } = await planBubblewrap(policy(), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    expect(args.slice(args.indexOf('--ro-bind'), args.indexOf('--ro-bind') + 11)).toEqual(['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/run', '--bind', work]);
    expect(args).toEqual(expect.arrayContaining(['--unshare-pid', '--unshare-ipc', '--die-with-parent']));
    expect(args.slice(-2)).toEqual(['--chdir', work]);
  });

  it('isolates the network exactly when the policy denies it', async () => {
    expect((await planBubblewrap(policy({ network: 'deny' }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()))).args).toContain('--unshare-net');
    expect((await planBubblewrap(policy({ network: 'allow' }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()))).args).not.toContain('--unshare-net');
  });

  it('keeps the systemd resolver reachable only when the network is allowed and the directory exists', async () => {
    const port: FilesystemPort = {
      ...nodeFilesystemPort(testKernelLock()),
      kindOf: (target) => (target === '/run/systemd/resolve' ? 'directory' : fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ? 'directory' : undefined),
      realpath: (target) => target,
      children: () => [],
      removePlaceholder: () => undefined,
    };
    expect(indexOfTriple((await planBubblewrap(policy({ network: 'allow' }), { cwd: work }, NEVER_CANCELLED, port)).args, '--ro-bind', '/run/systemd/resolve')).toBeGreaterThan(0);
    expect(indexOfTriple((await planBubblewrap(policy({ network: 'deny' }), { cwd: work }, NEVER_CANCELLED, port)).args, '--ro-bind', '/run/systemd/resolve')).toBe(-1);
  });

  it('binds every writable root read-write', async () => {
    const extra = path.join(base, 'extra');
    fs.mkdirSync(extra);
    const { args } = await planBubblewrap(policy({ writableRoots: [work, extra] }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    expect(indexOfTriple(args, '--bind', work)).toBeGreaterThan(0);
    expect(indexOfTriple(args, '--bind', extra)).toBeGreaterThan(0);
  });

  it('remounts existing write-denied paths read-only after the writable binds', async () => {
    const hooks = path.join(work, '.git', 'hooks');
    const config = path.join(work, '.git', 'config');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(config, '');
    const plan = await planBubblewrap(policy({ writeDenied: [hooks], writeDeniedLiterals: [config] }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    expect(indexOfTriple(plan.args, '--ro-bind', hooks)).toBeGreaterThan(indexOfTriple(plan.args, '--bind', work));
    expect(indexOfTriple(plan.args, '--ro-bind', config)).toBeGreaterThan(0);
    expect(plan.placeholders).toEqual([]);
  });

  it('reserves a missing protected path under the closure of a widening allow, which is bound read-write like a root', async () => {
    const wide = path.join(base, 'wide');
    fs.mkdirSync(wide);
    const fileRules = await fileRulesOf([fileSpec(`/${wide}/**`, { roots: [work], home, tool: 'Edit', effect: 'allow' })], [work]);
    const hooks = path.join(wide, '.git', 'hooks');
    const plan = await planBubblewrap(policy({ fileRules: await fileRules, writeDeniedLiterals: [hooks] }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    expect(indexOfTriple(plan.args, '--bind', wide)).toBeGreaterThan(0);
    expect(plan.placeholders).toEqual([path.join(wide, '.git')]);
    expect(indexOfTriple(plan.args, '--ro-bind', path.join(wide, '.git'), path.join(wide, '.git'))).toBeGreaterThan(0);
  });

  it('takes a hold on a placeholder that a running command created, for the file itself and for a path below it', async () => {
    const git = path.join(work, '.git');
    fs.writeFileSync(git, '');
    const held = new Set([git]);
    const below = await planBubblewrap(policy({ writeDeniedLiterals: [path.join(git, 'hooks')] }), { cwd: work, heldPlaceholders: held }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    expect(below.placeholders).toEqual([git]);
    expect(indexOfTriple(below.args, '--ro-bind', git, git)).toBeGreaterThan(0);
    const itself = await planBubblewrap(policy({ writeDeniedLiterals: [git] }), { cwd: work, heldPlaceholders: held }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    expect(itself.placeholders).toEqual([git]);
    const unrelated = await planBubblewrap(policy({ writeDeniedLiterals: [git] }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    expect(unrelated.placeholders).toEqual([]);
  });

  it('reserves the first missing component of a protected path under a writable root with a placeholder bound onto itself, so nothing can create it', async () => {
    const hooks = path.join(work, '.git', 'hooks');
    const config = path.join(work, '.git', 'config');
    const mcp = path.join(work, '.mcp.json');
    const plan = await planBubblewrap(policy({ writeDenied: [hooks], writeDeniedLiterals: [config, mcp] }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    const reserved = plan.args.flatMap((value, index) => (value === '--ro-bind' && plan.args[index + 1] === plan.args[index + 2] && plan.args[index + 1] !== '/' ? [plan.args[index + 1]] : []));
    expect(reserved.sort()).toEqual([path.join(work, '.git'), mcp].sort());
    expect(plan.placeholders.sort()).toEqual([path.join(work, '.git'), mcp].sort());
    expect(indexOfTriple(plan.args, '--ro-bind', hooks)).toBe(-1);
  });

  it('reserves the missing hooks directory of an existing .git and pins nothing outside the writable roots', async () => {
    fs.mkdirSync(path.join(work, '.git'));
    const hooks = path.join(work, '.git', 'hooks');
    const outside = path.join(home, 'missing', 'deep');
    const plan = await planBubblewrap(policy({ writeDenied: [hooks, outside] }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    expect(plan.placeholders).toEqual([hooks]);
    expect(indexOfTriple(plan.args, '--bind', path.join(work, '.git'))).toBeGreaterThan(0);
  });

  it('pins the directories between a protected path and the writable root so they cannot be renamed away', async () => {
    const hooks = path.join(work, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const { args } = await planBubblewrap(policy({ writeDenied: [hooks] }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    const pin = indexOfTriple(args, '--bind', path.join(work, '.git'));
    expect(pin).toBeGreaterThan(indexOfTriple(args, '--bind', work));
    expect(pin).toBeLessThan(indexOfTriple(args, '--ro-bind', hooks));
    expect(indexOfTriple(args, '--bind', work, work)).toBe(indexOfTriple(args, '--bind', work));
  });

  it('masks read-denied directories with a tmpfs and files with /dev/null, then restores read-allowed entries', async () => {
    const secretFile = path.join(home, 'token');
    fs.writeFileSync(secretFile, 'x');
    const { args } = await planBubblewrap(policy({ readDenied: [sessions, secretFile], readAllowed: [mine], writeDenied: [sessions] }), { cwd: work, tmpDir: mine }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    const maskIndex = args.findIndex((value, index) => value === '--tmpfs' && args[index + 1] === sessions);
    expect(maskIndex).toBeGreaterThan(0);
    expect(args.findIndex((value, index) => value === '--ro-bind' && args[index + 1] === '/dev/null' && args[index + 2] === secretFile)).toBeGreaterThan(0);
    const restore = indexOfTriple(args, '--ro-bind', mine);
    expect(restore).toBeGreaterThan(maskIndex);
    const scratch = indexOfTriple(args, '--bind', mine);
    expect(scratch).toBeGreaterThan(restore);
  });

  it('remounts every masked directory read-only after the masks and the restored entries, so a write to it fails instead of vanishing into the tmpfs', async () => {
    const { args } = await planBubblewrap(policy({ readDenied: [sessions], readAllowed: [mine], writeDenied: [sessions] }), { cwd: work, tmpDir: mine }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    const remount = args.findIndex((value, index) => value === '--remount-ro' && args[index + 1] === sessions);
    expect(remount).toBeGreaterThan(args.findIndex((value, index) => value === '--tmpfs' && args[index + 1] === sessions));
    expect(remount).toBeGreaterThan(indexOfTriple(args, '--bind', mine));
    expect(args.filter((value) => value === '--remount-ro')).toHaveLength(1);
  });

  it('gives the private scratch directory last, after every mask', async () => {
    const scratch = path.join(base, 'scratch');
    fs.mkdirSync(scratch);
    const { args } = await planBubblewrap(policy({ readDenied: [secrets] }), { cwd: work, scratchDir: scratch }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    expect(indexOfTriple(args, '--bind', scratch)).toBeGreaterThan(args.findIndex((value, index) => value === '--tmpfs' && args[index + 1] === secrets));
  });

  it('expands a read-deny glob to the files that exist and skips directories it already masks as a whole', async () => {
    fs.mkdirSync(path.join(work, 'a'), { recursive: true });
    fs.writeFileSync(path.join(work, 'a', '.env'), 'k');
    fs.writeFileSync(path.join(work, '.env'), 'k');
    fs.writeFileSync(path.join(work, 'keep.txt'), 'k');
    const rules = await FILE_RULES([fileSpec('**/.env', { roots: [work], home, tool: 'Read' })]);
    const { args } = await planBubblewrap(policy({ fileRules: await rules }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    const masked = args.flatMap((value, index) => (value === '--ro-bind' && args[index + 1] === '/dev/null' ? [args[index + 2]] : []));
    expect(masked.sort()).toEqual([path.join(work, '.env'), path.join(work, 'a', '.env')].sort());
  });

  it('turns a write-deny rule into read-only remounts of the matching existing files', async () => {
    fs.writeFileSync(path.join(work, 'locked.txt'), 'k');
    fs.writeFileSync(path.join(work, 'free.txt'), 'k');
    const rules = await FILE_RULES([fileSpec('locked.txt', { roots: [work], home, tool: 'Edit' })]);
    const { args } = await planBubblewrap(policy({ fileRules: await rules }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    expect(indexOfTriple(args, '--ro-bind', path.join(work, 'locked.txt'))).toBeGreaterThan(0);
    expect(indexOfTriple(args, '--ro-bind', path.join(work, 'free.txt'))).toBe(-1);
  });

  describe('the anchors of the nested git directories', () => {
    const gitDir = (): string => path.join(work, '.git');
    const modules = (): string => path.join(gitDir(), 'modules');

    const moduleAt = (directory: string): void => {
      fs.mkdirSync(path.join(directory, 'objects'), { recursive: true });
      fs.mkdirSync(path.join(directory, 'refs'));
      fs.writeFileSync(path.join(directory, 'HEAD'), 'ref: refs/heads/main\n');
    };

    const anchored = (): SandboxPolicy =>
      policy({ protectedSet: { ...EMPTY_PROTECTED_SET, roots: [work], moduleAnchors: [modules()], worktreeAnchors: [path.join(gitDir(), 'worktrees')] } });

    const positionOf = (args: readonly string[], flag: string, target: string): number => indexOfTriple(args, flag, target);

    it('reserves a missing modules directory with a placeholder so the kernel refuses a new module', async () => {
      fs.mkdirSync(gitDir());
      const plan = await planBubblewrap(anchored(), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
      expect(plan.placeholders).toContain(modules());
      expect(indexOfTriple(plan.args, '--ro-bind', '/dev/null', modules())).toBe(-1);
      expect(plan.args.findIndex((value, index) => value === '--ro-bind' && plan.args[index + 1] === modules() && plan.args[index + 2] === modules())).toBeGreaterThan(0);
    });

    it('binds an existing modules directory read-only and each module git directory writable after it', async () => {
      moduleAt(path.join(modules(), 'a'));
      const { args } = await planBubblewrap(anchored(), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
      const anchor = positionOf(args, '--ro-bind', modules());
      const module = positionOf(args, '--bind', path.join(modules(), 'a'));
      expect(anchor).toBeGreaterThan(0);
      expect(module).toBeGreaterThan(anchor);
    });

    it('pins hooks, config and config.worktree of a module whether they exist or not', async () => {
      const module = path.join(modules(), 'a');
      moduleAt(module);
      fs.mkdirSync(path.join(module, 'hooks'));
      const plan = await planBubblewrap(anchored(), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
      expect(positionOf(plan.args, '--ro-bind', path.join(module, 'hooks'))).toBeGreaterThan(0);
      expect(plan.placeholders).toEqual(expect.arrayContaining([path.join(module, 'config'), path.join(module, 'config.worktree')]));
      expect(plan.placeholders).not.toContain(path.join(module, 'hooks'));
    });

    it('applies the same rule to the modules directory of a module', async () => {
      const module = path.join(modules(), 'a');
      moduleAt(module);
      moduleAt(path.join(module, 'modules', 'b'));
      const plan = await planBubblewrap(anchored(), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
      expect(positionOf(plan.args, '--ro-bind', path.join(module, 'modules'))).toBeGreaterThan(positionOf(plan.args, '--bind', module));
      expect(positionOf(plan.args, '--bind', path.join(module, 'modules', 'b'))).toBeGreaterThan(positionOf(plan.args, '--ro-bind', path.join(module, 'modules')));
      expect(plan.placeholders).toContain(path.join(module, 'modules', 'b', 'config'));
    });

    it('reserves the modules directory of a module that has none', async () => {
      moduleAt(path.join(modules(), 'a'));
      const plan = await planBubblewrap(anchored(), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
      expect(plan.placeholders).toContain(path.join(modules(), 'a', 'modules'));
    });

    it('walks through a plain directory to a module whose name has a slash and leaves the plain directory read-only', async () => {
      moduleAt(path.join(modules(), 'group', 'b'));
      const plan = await planBubblewrap(anchored(), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
      expect(positionOf(plan.args, '--bind', path.join(modules(), 'group', 'b'))).toBeGreaterThan(0);
      expect(positionOf(plan.args, '--bind', path.join(modules(), 'group'))).toBe(-1);
      expect(plan.placeholders).toContain(path.join(modules(), 'group', 'b', 'config'));
    });

    it('does not mistake a directory without HEAD, objects and refs for a module', async () => {
      fs.mkdirSync(path.join(modules(), 'a', 'objects'), { recursive: true });
      const { args } = await planBubblewrap(anchored(), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
      expect(positionOf(args, '--bind', path.join(modules(), 'a'))).toBe(-1);
    });

    it('pins config.worktree of each existing worktree and leaves the worktrees directory writable', async () => {
      fs.mkdirSync(path.join(gitDir(), 'worktrees', 'wt'), { recursive: true });
      const plan = await planBubblewrap(anchored(), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
      expect(plan.placeholders).toContain(path.join(gitDir(), 'worktrees', 'wt', 'config.worktree'));
      expect(positionOf(plan.args, '--ro-bind', path.join(gitDir(), 'worktrees'))).toBe(-1);
    });

    describe('a symlink where a mount must land (a mount lands on the target, so the name stays replaceable)', () => {
      const refusal = async (overrides: Partial<SandboxPolicy> = {}): Promise<unknown> => {
        try {
          await planBubblewrap({ ...anchored(), ...overrides }, { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
        } catch (error) {
          return error;
        }
        return undefined;
      };

      it.each(['hooks', 'config', 'config.worktree'])('refuses a symlinked %s in a module git directory and names the link', async (name) => {
        const module = path.join(modules(), 'a');
        moduleAt(module);
        fs.mkdirSync(path.join(work, 'shared'));
        fs.symlinkSync(path.join(work, 'shared'), path.join(module, name));
        expect(await refusal()).toMatchObject({ name: 'SandboxPolicyError', code: 'protected_link_not_pinnable', path: path.join(module, name) });
      });

      it('refuses a dangling symlink in that place with the same error, not a raw EEXIST', async () => {
        const module = path.join(modules(), 'a');
        moduleAt(module);
        fs.symlinkSync(path.join(work, 'nowhere'), path.join(module, 'hooks'));
        expect(await refusal()).toMatchObject({ code: 'protected_link_not_pinnable', path: path.join(module, 'hooks') });
      });

      it('refuses a symlinked config.worktree of an existing worktree', async () => {
        const admin = path.join(gitDir(), 'worktrees', 'x');
        fs.mkdirSync(admin, { recursive: true });
        fs.writeFileSync(path.join(work, 'real-config'), '');
        fs.symlinkSync(path.join(work, 'real-config'), path.join(admin, 'config.worktree'));
        expect(await refusal()).toMatchObject({ code: 'protected_link_not_pinnable', path: path.join(admin, 'config.worktree') });
      });

      it('refuses a symlink found by a user write-deny rule', async () => {
        fs.writeFileSync(path.join(work, 'real.txt'), '');
        fs.symlinkSync(path.join(work, 'real.txt'), path.join(work, 'locked.txt'));
        const rules = await FILE_RULES([fileSpec('locked.txt', { roots: [work], home, tool: 'Edit' })]);
        expect(await refusal({ fileRules: await rules })).toMatchObject({ code: 'protected_link_not_pinnable', path: path.join(work, 'locked.txt') });
      });
    });

    describe('every mounted target pins its ancestors, so the directory cannot be renamed away with the mount', () => {
      it('pins the worktree administrative directory that holds a config.worktree', async () => {
        const admin = path.join(gitDir(), 'worktrees', 'x');
        fs.mkdirSync(admin, { recursive: true });
        fs.writeFileSync(path.join(admin, 'config.worktree'), '');
        const { args } = await planBubblewrap(anchored(), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
        expect(positionOf(args, '--ro-bind', path.join(admin, 'config.worktree'))).toBeGreaterThan(0);
        expect(positionOf(args, '--bind', admin)).toBeGreaterThan(0);
      });

      it('pins the directory of a path protected by a user rule', async () => {
        fs.mkdirSync(path.join(work, 'sub'));
        fs.writeFileSync(path.join(work, 'sub', 'locked.txt'), '');
        const rules = await FILE_RULES([fileSpec('**/locked.txt', { roots: [work], home, tool: 'Edit' })]);
        const { args } = await planBubblewrap(policy({ fileRules: await rules }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
        expect(positionOf(args, '--ro-bind', path.join(work, 'sub', 'locked.txt'))).toBeGreaterThan(0);
        expect(positionOf(args, '--bind', path.join(work, 'sub'))).toBeGreaterThan(0);
      });

      it('walks the worktrees of a module git directory and pins config.worktree there too', async () => {
        const module = path.join(modules(), 'a');
        moduleAt(module);
        const admin = path.join(module, 'worktrees', 't');
        fs.mkdirSync(admin, { recursive: true });
        const plan = await planBubblewrap(anchored(), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
        expect(plan.placeholders).toContain(path.join(admin, 'config.worktree'));
        expect(positionOf(plan.args, '--bind', admin)).toBeGreaterThan(0);
      });

      it('mounts an existing config.worktree of a module worktree read-only', async () => {
        const module = path.join(modules(), 'a');
        moduleAt(module);
        const admin = path.join(module, 'worktrees', 't');
        fs.mkdirSync(admin, { recursive: true });
        fs.writeFileSync(path.join(admin, 'config.worktree'), '');
        const { args } = await planBubblewrap(anchored(), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
        expect(positionOf(args, '--ro-bind', path.join(admin, 'config.worktree'))).toBeGreaterThan(0);
        expect(positionOf(args, '--bind', admin)).toBeGreaterThan(0);
      });

      it('reserves the config.worktree that an existing module worktree lacks, with a placeholder mounted over its name', async () => {
        const module = path.join(modules(), 'a');
        moduleAt(module);
        const admin = path.join(module, 'worktrees', 't');
        fs.mkdirSync(admin, { recursive: true });
        fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/t\n');
        const target = path.join(admin, 'config.worktree');
        const plan = await planBubblewrap(anchored(), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
        expect(plan.placeholders).toContain(target);
        expect(plan.args.findIndex((value, index) => value === '--ro-bind' && plan.args[index + 1] === target && plan.args[index + 2] === target)).toBeGreaterThan(0);
        expect(positionOf(plan.args, '--ro-bind', path.join(module, 'worktrees'))).toBe(-1);
      });

      it('leaves a module without a worktrees directory alone: nothing is mounted or reserved there, because git never adopts a worktree administrative directory', async () => {
        const module = path.join(modules(), 'a');
        moduleAt(module);
        const missing = path.join(module, 'worktrees');
        const plan = await planBubblewrap(anchored(), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
        expect(plan.placeholders.filter((placeholder) => placeholder.startsWith(missing))).toEqual([]);
        expect(plan.args.filter((value) => value.startsWith(missing))).toEqual([]);
        expect(plan.placeholders).toEqual(expect.arrayContaining([path.join(module, 'config.worktree'), path.join(module, 'hooks')]));
      });
    });

    it('ignores an anchor that lies outside every writable root', async () => {
      const elsewhere = path.join(base, 'elsewhere', 'modules');
      fs.mkdirSync(elsewhere, { recursive: true });
      const plan = await planBubblewrap(policy({ protectedSet: { ...EMPTY_PROTECTED_SET, moduleAnchors: [elsewhere] } }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
      expect(plan.placeholders).toEqual([]);
      expect(positionOf(plan.args, '--ro-bind', elsewhere)).toBe(-1);
    });
  });

  it('rejects the same invalid policies as the seatbelt profile', async () => {
    await expect(planBubblewrap(policy({ readAllowed: [mine] }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()))).rejects.toThrowError(expect.objectContaining({ code: 'read_allowed_not_inside_denied' }));
    await expect(planBubblewrap(policy({ writeDenied: ['relative'] }), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()))).rejects.toThrowError(expect.objectContaining({ code: 'entry_not_absolute' }));
  });
});
