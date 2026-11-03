import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import type { FileRuleSet } from '@momonga/foundation';
import { SandboxPolicyError, nodeFilesystemPort, planBubblewrap } from '@momonga/sandbox';
import type { FilesystemPort, SandboxPolicy } from '@momonga/sandbox';
import { fileRulesOf, fileSpec } from './file-rule-specs.ts';
import { makeTempDir } from './helpers.ts';

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

const FILE_RULES = (specs: ReturnType<typeof fileSpec>[]): FileRuleSet => fileRulesOf(specs, [work]);

describe('planBubblewrap refuses a protected name that is a symlink (review item 7)', () => {
  const refusal = (literal: string) => {
    try {
      planBubblewrap(policy({ writeDeniedLiterals: [literal] }), { cwd: work });
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it('refuses .git -> realgit with a SandboxPolicyError that names the path, because a mount cannot sit on a link name', () => {
    fs.mkdirSync(path.join(work, 'realgit'));
    fs.symlinkSync('realgit', path.join(work, '.git'));
    const error = refusal(path.join(work, '.git'));
    expect(error).toBeInstanceOf(SandboxPolicyError);
    expect(error).toMatchObject({ code: 'protected_link_not_pinnable', path: path.join(work, '.git') });
    expect((error as SandboxPolicyError).message).toContain(path.join(work, '.git'));
  });

  it('refuses a symlink loop at .git the same way instead of throwing a raw ELOOP', () => {
    fs.symlinkSync('.git', path.join(work, '.git'));
    const error = refusal(path.join(work, '.git'));
    expect(error).toBeInstanceOf(SandboxPolicyError);
    expect(error).toMatchObject({ code: 'protected_link_not_pinnable', path: path.join(work, '.git') });
  });

  it('refuses an entry that cannot be inspected because a loop lies in the way, naming it', () => {
    fs.symlinkSync('loop', path.join(work, 'loop'));
    const target = path.join(work, 'loop', 'inner');
    const error = refusal(target);
    expect(error).toBeInstanceOf(SandboxPolicyError);
    expect(error).toMatchObject({ code: 'protected_path_unreadable', path: target });
    expect((error as SandboxPolicyError).message).toContain(target);
  });

  it('refuses an entry below a directory of mode 000, naming it', () => {
    if (process.getuid?.() === 0) return;
    const locked = path.join(work, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      const target = path.join(locked, 'inner');
      const error = refusal(target);
      expect(error).toBeInstanceOf(SandboxPolicyError);
      expect(error).toMatchObject({ code: 'protected_path_unreadable', path: target });
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it('control: a regular file or a directory at the protected name is still pinned', () => {
    fs.mkdirSync(path.join(work, '.git'));
    const { args } = planBubblewrap(policy({ writeDeniedLiterals: [path.join(work, '.git')] }), { cwd: work });
    expect(indexOfTriple(args, '--ro-bind', path.join(work, '.git'))).toBeGreaterThan(-1);
  });
});

describe('planBubblewrap refuses only where the sandboxed process could change what it protects', () => {
  const unlessRoot = (): boolean => process.getuid?.() === 0;

  it('does not refuse a symlinked write-denied literal outside every writable area: the read-only root already holds it', () => {
    const launcher = path.join(home, 'momonga');
    fs.symlinkSync('target', launcher);
    const { args } = planBubblewrap(policy({ writeDeniedLiterals: [launcher] }), { cwd: work });
    expect(indexOfTriple(args, '--ro-bind', launcher)).toBe(-1);
  });

  it('treats EACCES outside every writable area as absent', () => {
    if (unlessRoot()) return;
    const locked = path.join(base, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      const target = path.join(locked, 'secret');
      expect(() => planBubblewrap(policy({ writeDeniedLiterals: [target] }), { cwd: work })).not.toThrow();
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it('refuses EACCES on a protected literal inside a writable area', () => {
    if (unlessRoot()) return;
    const locked = path.join(work, 'locked');
    fs.mkdirSync(locked);
    fs.chmodSync(locked, 0o000);
    try {
      const target = path.join(locked, 'secret');
      expect(() => planBubblewrap(policy({ writeDeniedLiterals: [target] }), { cwd: work })).toThrowError(expect.objectContaining({ code: 'protected_path_unreadable', path: target }));
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it('refuses an unreachable ancestor of a writable root, and ignores an unreachable path elsewhere', () => {
    const elsewhere = path.join(sessions, 'x');
    const port: FilesystemPort = { ...nodeFilesystemPort, kindOf: (target) => (target === base || target === elsewhere ? 'unreachable' : nodeFilesystemPort.kindOf(target)) };
    expect(() => planBubblewrap(policy({ writeDeniedLiterals: [base] }), { cwd: work }, port)).toThrowError(expect.objectContaining({ code: 'protected_path_unreadable', path: base }));
    expect(() => planBubblewrap(policy({ writeDeniedLiterals: [elsewhere] }), { cwd: work }, port)).not.toThrow();
  });

  it('applies the same rule to a directory that cannot be listed while a deny pattern expands', () => {
    const elsewhere = path.join(base, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const unlistable: FilesystemPort = { ...nodeFilesystemPort, children: () => 'unreachable' };
    const outsideRules = fileRulesOf([fileSpec('**/.env', { roots: [elsewhere], home, tool: 'Read' })], [elsewhere]);
    expect(() => planBubblewrap(policy({ fileRules: outsideRules }), { cwd: work }, unlistable)).not.toThrow();
    const insideRules = FILE_RULES([fileSpec('**/.env', { roots: [work], home, tool: 'Read' })]);
    expect(() => planBubblewrap(policy({ fileRules: insideRules }), { cwd: work }, unlistable)).toThrowError(expect.objectContaining({ code: 'protected_path_unreadable', path: work }));
  });
});

describe('planBubblewrap', () => {
  it('starts from a read-only view of the host with devices, a private proc and a masked /run', () => {
    const { args } = planBubblewrap(policy(), { cwd: work });
    expect(args.slice(args.indexOf('--ro-bind'), args.indexOf('--ro-bind') + 11)).toEqual(['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/run', '--bind', work]);
    expect(args).toEqual(expect.arrayContaining(['--unshare-pid', '--unshare-ipc', '--die-with-parent']));
    expect(args.slice(-2)).toEqual(['--chdir', work]);
  });

  it('isolates the network exactly when the policy denies it', () => {
    expect(planBubblewrap(policy({ network: 'deny' }), { cwd: work }).args).toContain('--unshare-net');
    expect(planBubblewrap(policy({ network: 'allow' }), { cwd: work }).args).not.toContain('--unshare-net');
  });

  it('keeps the systemd resolver reachable only when the network is allowed and the directory exists', () => {
    const port: FilesystemPort = {
      ...nodeFilesystemPort,
      kindOf: (target) => (target === '/run/systemd/resolve' ? 'directory' : fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ? 'directory' : undefined),
      realpath: (target) => target,
      children: () => [],
      removePlaceholder: () => undefined,
    };
    expect(indexOfTriple(planBubblewrap(policy({ network: 'allow' }), { cwd: work }, port).args, '--ro-bind', '/run/systemd/resolve')).toBeGreaterThan(0);
    expect(indexOfTriple(planBubblewrap(policy({ network: 'deny' }), { cwd: work }, port).args, '--ro-bind', '/run/systemd/resolve')).toBe(-1);
  });

  it('binds every writable root read-write', () => {
    const extra = path.join(base, 'extra');
    fs.mkdirSync(extra);
    const { args } = planBubblewrap(policy({ writableRoots: [work, extra] }), { cwd: work });
    expect(indexOfTriple(args, '--bind', work)).toBeGreaterThan(0);
    expect(indexOfTriple(args, '--bind', extra)).toBeGreaterThan(0);
  });

  it('remounts existing write-denied paths read-only after the writable binds', () => {
    const hooks = path.join(work, '.git', 'hooks');
    const config = path.join(work, '.git', 'config');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(config, '');
    const plan = planBubblewrap(policy({ writeDenied: [hooks], writeDeniedLiterals: [config] }), { cwd: work });
    expect(indexOfTriple(plan.args, '--ro-bind', hooks)).toBeGreaterThan(indexOfTriple(plan.args, '--bind', work));
    expect(indexOfTriple(plan.args, '--ro-bind', config)).toBeGreaterThan(0);
    expect(plan.placeholders).toEqual([]);
  });

  it('reserves a missing protected path under the closure of a widening allow, which is bound read-write like a root', () => {
    const wide = path.join(base, 'wide');
    fs.mkdirSync(wide);
    const fileRules = fileRulesOf([fileSpec(`/${wide}/**`, { roots: [work], home, tool: 'Edit', effect: 'allow' })], [work]);
    const hooks = path.join(wide, '.git', 'hooks');
    const plan = planBubblewrap(policy({ fileRules, writeDeniedLiterals: [hooks] }), { cwd: work });
    expect(indexOfTriple(plan.args, '--bind', wide)).toBeGreaterThan(0);
    expect(plan.placeholders).toEqual([path.join(wide, '.git')]);
    expect(indexOfTriple(plan.args, '--ro-bind', '/dev/null', path.join(wide, '.git'))).toBeGreaterThan(0);
  });

  it('takes a hold on a placeholder that a running command created, for the file itself and for a path below it', () => {
    const git = path.join(work, '.git');
    fs.writeFileSync(git, '');
    const held = new Set([git]);
    const below = planBubblewrap(policy({ writeDeniedLiterals: [path.join(git, 'hooks')] }), { cwd: work, heldPlaceholders: held });
    expect(below.placeholders).toEqual([git]);
    expect(indexOfTriple(below.args, '--ro-bind', '/dev/null', git)).toBeGreaterThan(0);
    const itself = planBubblewrap(policy({ writeDeniedLiterals: [git] }), { cwd: work, heldPlaceholders: held });
    expect(itself.placeholders).toEqual([git]);
    const unrelated = planBubblewrap(policy({ writeDeniedLiterals: [git] }), { cwd: work });
    expect(unrelated.placeholders).toEqual([]);
  });

  it('reserves the first missing component of a protected path under a writable root with /dev/null, so nothing can create it', () => {
    const hooks = path.join(work, '.git', 'hooks');
    const config = path.join(work, '.git', 'config');
    const mcp = path.join(work, '.mcp.json');
    const plan = planBubblewrap(policy({ writeDenied: [hooks], writeDeniedLiterals: [config, mcp] }), { cwd: work });
    const reserved = plan.args.flatMap((value, index) => (value === '--ro-bind' && plan.args[index + 1] === '/dev/null' ? [plan.args[index + 2]] : []));
    expect(reserved.sort()).toEqual([path.join(work, '.git'), mcp].sort());
    expect(plan.placeholders.sort()).toEqual([path.join(work, '.git'), mcp].sort());
    expect(indexOfTriple(plan.args, '--ro-bind', hooks)).toBe(-1);
  });

  it('reserves the missing hooks directory of an existing .git and pins nothing outside the writable roots', () => {
    fs.mkdirSync(path.join(work, '.git'));
    const hooks = path.join(work, '.git', 'hooks');
    const outside = path.join(home, 'missing', 'deep');
    const plan = planBubblewrap(policy({ writeDenied: [hooks, outside] }), { cwd: work });
    expect(plan.placeholders).toEqual([hooks]);
    expect(indexOfTriple(plan.args, '--bind', path.join(work, '.git'))).toBeGreaterThan(0);
  });

  it('pins the directories between a protected path and the writable root so they cannot be renamed away', () => {
    const hooks = path.join(work, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    const { args } = planBubblewrap(policy({ writeDenied: [hooks] }), { cwd: work });
    const pin = indexOfTriple(args, '--bind', path.join(work, '.git'));
    expect(pin).toBeGreaterThan(indexOfTriple(args, '--bind', work));
    expect(pin).toBeLessThan(indexOfTriple(args, '--ro-bind', hooks));
    expect(indexOfTriple(args, '--bind', work, work)).toBe(indexOfTriple(args, '--bind', work));
  });

  it('masks read-denied directories with a tmpfs and files with /dev/null, then restores read-allowed entries', () => {
    const secretFile = path.join(home, 'token');
    fs.writeFileSync(secretFile, 'x');
    const { args } = planBubblewrap(policy({ readDenied: [sessions, secretFile], readAllowed: [mine], writeDenied: [sessions] }), { cwd: work, tmpDir: mine });
    const maskIndex = args.findIndex((value, index) => value === '--tmpfs' && args[index + 1] === sessions);
    expect(maskIndex).toBeGreaterThan(0);
    expect(args.findIndex((value, index) => value === '--ro-bind' && args[index + 1] === '/dev/null' && args[index + 2] === secretFile)).toBeGreaterThan(0);
    const restore = indexOfTriple(args, '--ro-bind', mine);
    expect(restore).toBeGreaterThan(maskIndex);
    const scratch = indexOfTriple(args, '--bind', mine);
    expect(scratch).toBeGreaterThan(restore);
  });

  it('remounts every masked directory read-only after the masks and the restored entries, so a write to it fails instead of vanishing into the tmpfs', () => {
    const { args } = planBubblewrap(policy({ readDenied: [sessions], readAllowed: [mine], writeDenied: [sessions] }), { cwd: work, tmpDir: mine });
    const remount = args.findIndex((value, index) => value === '--remount-ro' && args[index + 1] === sessions);
    expect(remount).toBeGreaterThan(args.findIndex((value, index) => value === '--tmpfs' && args[index + 1] === sessions));
    expect(remount).toBeGreaterThan(indexOfTriple(args, '--bind', mine));
    expect(args.filter((value) => value === '--remount-ro')).toHaveLength(1);
  });

  it('gives the private scratch directory last, after every mask', () => {
    const scratch = path.join(base, 'scratch');
    fs.mkdirSync(scratch);
    const { args } = planBubblewrap(policy({ readDenied: [secrets] }), { cwd: work, scratchDir: scratch });
    expect(indexOfTriple(args, '--bind', scratch)).toBeGreaterThan(args.findIndex((value, index) => value === '--tmpfs' && args[index + 1] === secrets));
  });

  it('expands a read-deny glob to the files that exist and skips directories it already masks as a whole', () => {
    fs.mkdirSync(path.join(work, 'a'), { recursive: true });
    fs.writeFileSync(path.join(work, 'a', '.env'), 'k');
    fs.writeFileSync(path.join(work, '.env'), 'k');
    fs.writeFileSync(path.join(work, 'keep.txt'), 'k');
    const rules = FILE_RULES([fileSpec('**/.env', { roots: [work], home, tool: 'Read' })]);
    const { args } = planBubblewrap(policy({ fileRules: rules }), { cwd: work });
    const masked = args.flatMap((value, index) => (value === '--ro-bind' && args[index + 1] === '/dev/null' ? [args[index + 2]] : []));
    expect(masked.sort()).toEqual([path.join(work, '.env'), path.join(work, 'a', '.env')].sort());
  });

  it('turns a write-deny rule into read-only remounts of the matching existing files', () => {
    fs.writeFileSync(path.join(work, 'locked.txt'), 'k');
    fs.writeFileSync(path.join(work, 'free.txt'), 'k');
    const rules = FILE_RULES([fileSpec('locked.txt', { roots: [work], home, tool: 'Edit' })]);
    const { args } = planBubblewrap(policy({ fileRules: rules }), { cwd: work });
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

    it('reserves a missing modules directory with a placeholder so the kernel refuses a new module', () => {
      fs.mkdirSync(gitDir());
      const plan = planBubblewrap(anchored(), { cwd: work });
      expect(plan.placeholders).toContain(modules());
      expect(indexOfTriple(plan.args, '--ro-bind', modules())).toBe(-1);
      expect(plan.args.findIndex((value, index) => value === '--ro-bind' && plan.args[index + 1] === '/dev/null' && plan.args[index + 2] === modules())).toBeGreaterThan(0);
    });

    it('binds an existing modules directory read-only and each module git directory writable after it', () => {
      moduleAt(path.join(modules(), 'a'));
      const { args } = planBubblewrap(anchored(), { cwd: work });
      const anchor = positionOf(args, '--ro-bind', modules());
      const module = positionOf(args, '--bind', path.join(modules(), 'a'));
      expect(anchor).toBeGreaterThan(0);
      expect(module).toBeGreaterThan(anchor);
    });

    it('pins hooks, config and config.worktree of a module whether they exist or not', () => {
      const module = path.join(modules(), 'a');
      moduleAt(module);
      fs.mkdirSync(path.join(module, 'hooks'));
      const plan = planBubblewrap(anchored(), { cwd: work });
      expect(positionOf(plan.args, '--ro-bind', path.join(module, 'hooks'))).toBeGreaterThan(0);
      expect(plan.placeholders).toEqual(expect.arrayContaining([path.join(module, 'config'), path.join(module, 'config.worktree')]));
      expect(plan.placeholders).not.toContain(path.join(module, 'hooks'));
    });

    it('applies the same rule to the modules directory of a module', () => {
      const module = path.join(modules(), 'a');
      moduleAt(module);
      moduleAt(path.join(module, 'modules', 'b'));
      const plan = planBubblewrap(anchored(), { cwd: work });
      expect(positionOf(plan.args, '--ro-bind', path.join(module, 'modules'))).toBeGreaterThan(positionOf(plan.args, '--bind', module));
      expect(positionOf(plan.args, '--bind', path.join(module, 'modules', 'b'))).toBeGreaterThan(positionOf(plan.args, '--ro-bind', path.join(module, 'modules')));
      expect(plan.placeholders).toContain(path.join(module, 'modules', 'b', 'config'));
    });

    it('reserves the modules directory of a module that has none', () => {
      moduleAt(path.join(modules(), 'a'));
      const plan = planBubblewrap(anchored(), { cwd: work });
      expect(plan.placeholders).toContain(path.join(modules(), 'a', 'modules'));
    });

    it('walks through a plain directory to a module whose name has a slash and leaves the plain directory read-only', () => {
      moduleAt(path.join(modules(), 'group', 'b'));
      const plan = planBubblewrap(anchored(), { cwd: work });
      expect(positionOf(plan.args, '--bind', path.join(modules(), 'group', 'b'))).toBeGreaterThan(0);
      expect(positionOf(plan.args, '--bind', path.join(modules(), 'group'))).toBe(-1);
      expect(plan.placeholders).toContain(path.join(modules(), 'group', 'b', 'config'));
    });

    it('does not mistake a directory without HEAD, objects and refs for a module', () => {
      fs.mkdirSync(path.join(modules(), 'a', 'objects'), { recursive: true });
      const { args } = planBubblewrap(anchored(), { cwd: work });
      expect(positionOf(args, '--bind', path.join(modules(), 'a'))).toBe(-1);
    });

    it('pins config.worktree of each existing worktree and leaves the worktrees directory writable', () => {
      fs.mkdirSync(path.join(gitDir(), 'worktrees', 'wt'), { recursive: true });
      const plan = planBubblewrap(anchored(), { cwd: work });
      expect(plan.placeholders).toContain(path.join(gitDir(), 'worktrees', 'wt', 'config.worktree'));
      expect(positionOf(plan.args, '--ro-bind', path.join(gitDir(), 'worktrees'))).toBe(-1);
    });

    describe('a symlink where a mount must land (a mount lands on the target, so the name stays replaceable)', () => {
      const refusal = (overrides: Partial<SandboxPolicy> = {}): unknown => {
        try {
          planBubblewrap({ ...anchored(), ...overrides }, { cwd: work });
        } catch (error) {
          return error;
        }
        return undefined;
      };

      it.each(['hooks', 'config', 'config.worktree'])('refuses a symlinked %s in a module git directory and names the link', (name) => {
        const module = path.join(modules(), 'a');
        moduleAt(module);
        fs.mkdirSync(path.join(work, 'shared'));
        fs.symlinkSync(path.join(work, 'shared'), path.join(module, name));
        expect(refusal()).toMatchObject({ name: 'SandboxPolicyError', code: 'protected_link_not_pinnable', path: path.join(module, name) });
      });

      it('refuses a dangling symlink in that place with the same error, not a raw EEXIST', () => {
        const module = path.join(modules(), 'a');
        moduleAt(module);
        fs.symlinkSync(path.join(work, 'nowhere'), path.join(module, 'hooks'));
        expect(refusal()).toMatchObject({ code: 'protected_link_not_pinnable', path: path.join(module, 'hooks') });
      });

      it('refuses a symlinked config.worktree of an existing worktree', () => {
        const admin = path.join(gitDir(), 'worktrees', 'x');
        fs.mkdirSync(admin, { recursive: true });
        fs.writeFileSync(path.join(work, 'real-config'), '');
        fs.symlinkSync(path.join(work, 'real-config'), path.join(admin, 'config.worktree'));
        expect(refusal()).toMatchObject({ code: 'protected_link_not_pinnable', path: path.join(admin, 'config.worktree') });
      });

      it('refuses a symlink found by a user write-deny rule', () => {
        fs.writeFileSync(path.join(work, 'real.txt'), '');
        fs.symlinkSync(path.join(work, 'real.txt'), path.join(work, 'locked.txt'));
        const rules = FILE_RULES([fileSpec('locked.txt', { roots: [work], home, tool: 'Edit' })]);
        expect(refusal({ fileRules: rules })).toMatchObject({ code: 'protected_link_not_pinnable', path: path.join(work, 'locked.txt') });
      });
    });

    describe('every mounted target pins its ancestors, so the directory cannot be renamed away with the mount', () => {
      it('pins the worktree administrative directory that holds a config.worktree', () => {
        const admin = path.join(gitDir(), 'worktrees', 'x');
        fs.mkdirSync(admin, { recursive: true });
        fs.writeFileSync(path.join(admin, 'config.worktree'), '');
        const { args } = planBubblewrap(anchored(), { cwd: work });
        expect(positionOf(args, '--ro-bind', path.join(admin, 'config.worktree'))).toBeGreaterThan(0);
        expect(positionOf(args, '--bind', admin)).toBeGreaterThan(0);
      });

      it('pins the directory of a path protected by a user rule', () => {
        fs.mkdirSync(path.join(work, 'sub'));
        fs.writeFileSync(path.join(work, 'sub', 'locked.txt'), '');
        const rules = FILE_RULES([fileSpec('**/locked.txt', { roots: [work], home, tool: 'Edit' })]);
        const { args } = planBubblewrap(policy({ fileRules: rules }), { cwd: work });
        expect(positionOf(args, '--ro-bind', path.join(work, 'sub', 'locked.txt'))).toBeGreaterThan(0);
        expect(positionOf(args, '--bind', path.join(work, 'sub'))).toBeGreaterThan(0);
      });

      it('walks the worktrees of a module git directory and pins config.worktree there too', () => {
        const module = path.join(modules(), 'a');
        moduleAt(module);
        const admin = path.join(module, 'worktrees', 't');
        fs.mkdirSync(admin, { recursive: true });
        const plan = planBubblewrap(anchored(), { cwd: work });
        expect(plan.placeholders).toContain(path.join(admin, 'config.worktree'));
        expect(positionOf(plan.args, '--bind', admin)).toBeGreaterThan(0);
      });

      it('mounts an existing config.worktree of a module worktree read-only', () => {
        const module = path.join(modules(), 'a');
        moduleAt(module);
        const admin = path.join(module, 'worktrees', 't');
        fs.mkdirSync(admin, { recursive: true });
        fs.writeFileSync(path.join(admin, 'config.worktree'), '');
        const { args } = planBubblewrap(anchored(), { cwd: work });
        expect(positionOf(args, '--ro-bind', path.join(admin, 'config.worktree'))).toBeGreaterThan(0);
        expect(positionOf(args, '--bind', admin)).toBeGreaterThan(0);
      });

      it('reserves the config.worktree that an existing module worktree lacks, with a placeholder mounted over its name', () => {
        const module = path.join(modules(), 'a');
        moduleAt(module);
        const admin = path.join(module, 'worktrees', 't');
        fs.mkdirSync(admin, { recursive: true });
        fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/t\n');
        const target = path.join(admin, 'config.worktree');
        const plan = planBubblewrap(anchored(), { cwd: work });
        expect(plan.placeholders).toContain(target);
        expect(plan.args.findIndex((value, index) => value === '--ro-bind' && plan.args[index + 1] === '/dev/null' && plan.args[index + 2] === target)).toBeGreaterThan(0);
        expect(positionOf(plan.args, '--ro-bind', path.join(module, 'worktrees'))).toBe(-1);
      });

      it('leaves a module without a worktrees directory alone: nothing is mounted or reserved there, because git never adopts a worktree administrative directory', () => {
        const module = path.join(modules(), 'a');
        moduleAt(module);
        const missing = path.join(module, 'worktrees');
        const plan = planBubblewrap(anchored(), { cwd: work });
        expect(plan.placeholders.filter((placeholder) => placeholder.startsWith(missing))).toEqual([]);
        expect(plan.args.filter((value) => value.startsWith(missing))).toEqual([]);
        expect(plan.placeholders).toEqual(expect.arrayContaining([path.join(module, 'config.worktree'), path.join(module, 'hooks')]));
      });
    });

    it('ignores an anchor that lies outside every writable root', () => {
      const elsewhere = path.join(base, 'elsewhere', 'modules');
      fs.mkdirSync(elsewhere, { recursive: true });
      const plan = planBubblewrap(policy({ protectedSet: { ...EMPTY_PROTECTED_SET, moduleAnchors: [elsewhere] } }), { cwd: work });
      expect(plan.placeholders).toEqual([]);
      expect(positionOf(plan.args, '--ro-bind', elsewhere)).toBe(-1);
    });
  });

  it('rejects the same invalid policies as the seatbelt profile', () => {
    expect(() => planBubblewrap(policy({ readAllowed: [mine] }), { cwd: work })).toThrowError(expect.objectContaining({ code: 'read_allowed_not_inside_denied' }));
    expect(() => planBubblewrap(policy({ writeDenied: ['relative'] }), { cwd: work })).toThrowError(expect.objectContaining({ code: 'entry_not_absolute' }));
  });
});
