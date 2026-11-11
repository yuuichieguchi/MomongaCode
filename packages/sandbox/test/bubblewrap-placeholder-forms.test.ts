import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, protectedSetFor } from '@momonga/foundation';
import type { PlaceholderForm } from '@momonga/foundation';
import { createBubblewrapSandbox, createPlaceholderJournal, identityOf, nodeFilesystemPort, planBubblewrap } from '@momonga/sandbox';
import type { PlaceholderJournal, SandboxPolicy } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, fakePolicyFilesystem, NEVER_CANCELLED, testKernelLock } from '@momonga/testkit';
import { makeTempDir, run } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const EMPTY_FILE: PlaceholderForm = { kind: 'file', bytes: '' };
const COMMONDIR_FORM: PlaceholderForm = { kind: 'file', bytes: '.\n' };
const DIRECTORY_FORM: PlaceholderForm = { kind: 'directory' };

const PASS_THROUGH_BWRAP = `#!/bin/sh
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`;

let base = '';
let work = '';

beforeEach(() => {
  base = fs.realpathSync(makeTempDir());
  work = path.join(base, 'work');
  fs.mkdirSync(work);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const protectedPolicy = async (): Promise<SandboxPolicy> => {
  const protectedSet = await protectedSetFor([work], fakePolicyFilesystem({ platform: 'linux' }));
  return {
    writableRoots: [work],
    writeDenied: [...protectedSet.paths],
    writeDeniedLiterals: [],
    readDenied: [],
    network: 'deny',
    fileRules: EMPTY_FILE_RULES,
    protectedSet,
  };
};

const indexOfTriple = (args: readonly string[], flag: string, source: string, dest = source): number =>
  args.findIndex((value, index) => value === flag && args[index + 1] === source && args[index + 2] === dest);

describe('planBubblewrap mounts each placeholder on its own path, in its form', () => {
  it('reserves the .git of a root that is not a repository as an empty directory bound read-only onto itself', async () => {
    const git = path.join(work, '.git');
    const plan = await planBubblewrap(await protectedPolicy(), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    expect(plan.placeholders).toContain(git);
    expect(plan.forms[git]).toEqual(DIRECTORY_FORM);
    expect(plan.forms[path.join(work, '.mcp.json')]).toEqual(EMPTY_FILE);
    expect(indexOfTriple(plan.args, '--ro-bind', git, git)).toBeGreaterThan(0);
    expect(indexOfTriple(plan.args, '--ro-bind', '/dev/null', git)).toBe(-1);
  });

  it('reserves the missing commondir of an existing .git directory as a file holding a dot and a newline', async () => {
    const git = path.join(work, '.git');
    fs.mkdirSync(git);
    const commondir = path.join(git, 'commondir');
    const plan = await planBubblewrap(await protectedPolicy(), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    expect(plan.placeholders).toEqual(expect.arrayContaining([commondir, path.join(git, 'config.worktree')]));
    expect(plan.forms[commondir]).toEqual(COMMONDIR_FORM);
    expect(plan.forms[path.join(git, 'config.worktree')]).toEqual(EMPTY_FILE);
    expect(indexOfTriple(plan.args, '--ro-bind', commondir, commondir)).toBeGreaterThan(0);
  });

  it('never mounts /dev/null over a placeholder', async () => {
    fs.mkdirSync(path.join(work, '.git'));
    const plan = await planBubblewrap(await protectedPolicy(), { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    expect(plan.placeholders.length).toBeGreaterThan(0);
    expect(plan.args).not.toContain('/dev/null');
    for (const placeholder of plan.placeholders) expect(indexOfTriple(plan.args, '--ro-bind', placeholder, placeholder)).toBeGreaterThan(0);
  });

  it('gives a path the protected set has no form for an empty file', async () => {
    const extra = path.join(work, 'deny-me');
    const plan = await planBubblewrap({ ...(await protectedPolicy()), writeDeniedLiterals: [extra] }, { cwd: work }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    expect(plan.forms[extra]).toEqual(EMPTY_FILE);
    expect(indexOfTriple(plan.args, '--ro-bind', extra, extra)).toBeGreaterThan(0);
  });

  it('takes a hold on a held .git directory placeholder for a protected path below it instead of reserving a file inside it', async () => {
    const git = path.join(work, '.git');
    fs.mkdirSync(git);
    const policy: SandboxPolicy = { ...(await protectedPolicy()), writeDenied: [], writeDeniedLiterals: [path.join(git, 'hooks')], protectedSet: EMPTY_PROTECTED_SET };
    const plan = await planBubblewrap(policy, { cwd: work, heldPlaceholders: new Set([git]) }, NEVER_CANCELLED, nodeFilesystemPort(testKernelLock()));
    expect(plan.placeholders).toEqual([git]);
    expect(indexOfTriple(plan.args, '--ro-bind', git, git)).toBeGreaterThan(0);
    expect(indexOfTriple(plan.args, '--ro-bind', path.join(git, 'hooks'), path.join(git, 'hooks'))).toBe(-1);
  });
});

describe('the host creates a placeholder in its form', () => {
  it('creates a directory form with mkdir, empty, and returns its identity', async () => {
    const target = path.join(work, '.git');
    const identity = await nodeFilesystemPort(testKernelLock()).createPlaceholder(target, DIRECTORY_FORM);
    expect(fs.lstatSync(target).isDirectory()).toBe(true);
    expect(fs.readdirSync(target)).toEqual([]);
    expect(identity).toEqual(await identityOf(target));
  });

  it('creates a file form with exactly its bytes', async () => {
    fs.mkdirSync(path.join(work, '.git'));
    const target = path.join(work, '.git', 'commondir');
    const identity = await nodeFilesystemPort(testKernelLock()).createPlaceholder(target, COMMONDIR_FORM);
    expect(fs.lstatSync(target).isFile()).toBe(true);
    expect(fs.readFileSync(target, 'latin1')).toBe('.\n');
    expect(identity).toEqual(await identityOf(target));
  });

  it('never takes a file of a person: an existing file stays as it was and creation fails', async () => {
    const target = path.join(work, '.mcp.json');
    fs.writeFileSync(target, '{"mine":true}');
    await expect((async () => nodeFilesystemPort(testKernelLock()).createPlaceholder(target, COMMONDIR_FORM))()).rejects.toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(fs.readFileSync(target, 'utf8')).toBe('{"mine":true}');
  });

  it('never takes a directory of a person: an existing directory stays as it was and creation fails', async () => {
    const target = path.join(work, '.git');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'HEAD'), 'ref: refs/heads/main\n');
    await expect((async () => nodeFilesystemPort(testKernelLock()).createPlaceholder(target, DIRECTORY_FORM))()).rejects.toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(fs.readdirSync(target)).toEqual(['HEAD']);
  });
});

describe('a command holds placeholders in their form and release removes them (stand-in bwrap)', () => {
  let tmpRoot = '';
  let journal: PlaceholderJournal;

  beforeEach(() => {
    tmpRoot = path.join(base, 'tmp');
    fs.mkdirSync(tmpRoot);
    fs.writeFileSync(path.join(base, 'bwrap'), PASS_THROUGH_BWRAP, { mode: 0o755 });
    journal = createPlaceholderJournal(path.join(base, 'journal'));
  });

  const start = async (script: string) =>
    createBubblewrapSandbox({ lock: testKernelLock(), bwrapPath: path.join(base, 'bwrap'), tmpRoot, killGraceMs: 300, journal, holders: () => new Set() }).spawn(
      { argv: ['/bin/sh', '-c', script], cwd: work, env: { PATH: '/usr/bin:/bin' } },
      await protectedPolicy(),
      new AbortController().signal,
    );

  it('shows the command an empty .git directory, journals its form, and removes it after release', async () => {
    const result = await run(await start('[ -d .git ] && [ -z "$(ls -A .git)" ] && [ -f .mcp.json ] && [ ! -s .mcp.json ] && echo forms-ok'));
    expect(result.stdout.trim()).toBe('forms-ok');
    expect(fs.existsSync(path.join(work, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(work, '.mcp.json'))).toBe(false);
    expect(await journal.records()).toEqual([]);
  });

  it('shows the command a commondir holding a dot and a newline, and removes it after release', async () => {
    fs.mkdirSync(path.join(work, '.git'));
    const result = await run(await start('cat .git/commondir'));
    expect(result.stdout).toBe('.\n');
    expect(fs.existsSync(path.join(work, '.git', 'commondir'))).toBe(false);
    expect(fs.existsSync(path.join(work, '.git', 'config.worktree'))).toBe(false);
    expect(fs.readdirSync(path.join(work, '.git'))).toEqual([]);
  });

  it('records the form of each placeholder while the command runs', async () => {
    const result = await run(await start(`cat ${path.join(base, 'journal')}/*.json`));
    expect(result.stdout).toContain(`"path":${JSON.stringify(path.join(work, '.git'))}`);
    expect(result.stdout).toContain(JSON.stringify({ kind: 'directory' }));
    expect(result.stdout).toContain(JSON.stringify({ kind: 'file', bytes: '' }));
  });

  it('leaves a .git directory that the command filled, and a commondir whose bytes changed', async () => {
    await run(await start(': > .git/x'));
    expect(fs.readdirSync(path.join(work, '.git'))).toEqual(['x']);
    fs.rmSync(path.join(work, '.git'), { recursive: true });
    fs.mkdirSync(path.join(work, '.git'));
    await run(await start('printf ../main > .git/commondir'));
    expect(fs.readFileSync(path.join(work, '.git', 'commondir'), 'utf8')).toBe('../main');
    expect(await journal.records()).toEqual([]);
  });
});
