import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import type { FileRuleSet } from '@momonga/foundation';
import { planBubblewrap } from '@momonga/sandbox';
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
      kindOf: (target) => (target === '/run/systemd/resolve' ? 'directory' : fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ? 'directory' : undefined),
      realpath: (target) => target,
      children: () => [],
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

  it('remounts existing write-denied paths read-only after the writable binds and reports missing ones as unprotected', () => {
    const hooks = path.join(work, '.git', 'hooks');
    const config = path.join(work, '.git', 'config');
    fs.mkdirSync(hooks, { recursive: true });
    const missing = path.join(work, '.mcp.json');
    const plan = planBubblewrap(policy({ writeDenied: [hooks], writeDeniedLiterals: [config, missing] }), { cwd: work });
    fs.writeFileSync(config, '');
    const withConfig = planBubblewrap(policy({ writeDenied: [hooks], writeDeniedLiterals: [config, missing] }), { cwd: work });
    expect(indexOfTriple(plan.args, '--ro-bind', hooks)).toBeGreaterThan(indexOfTriple(plan.args, '--bind', work));
    expect(plan.unprotected).toEqual([config, missing]);
    expect(withConfig.unprotected).toEqual([missing]);
    expect(indexOfTriple(withConfig.args, '--ro-bind', config)).toBeGreaterThan(0);
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

  it('rejects the same invalid policies as the seatbelt profile', () => {
    expect(() => planBubblewrap(policy({ readAllowed: [mine] }), { cwd: work })).toThrowError(expect.objectContaining({ code: 'read_allowed_not_inside_denied' }));
    expect(() => planBubblewrap(policy({ writeDenied: ['relative'] }), { cwd: work })).toThrowError(expect.objectContaining({ code: 'entry_not_absolute' }));
  });
});
