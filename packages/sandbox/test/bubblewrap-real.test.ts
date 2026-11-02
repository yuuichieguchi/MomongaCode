import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { DEFAULT_BWRAP_PATH, SandboxPolicyError, createBubblewrapSandbox } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { killGroupsForCleanup, waitFor } from '@momonga/testkit';
import { fileRulesOf, fileSpec } from './file-rule-specs.ts';
import { makeTempDir, run } from './helpers.ts';

const KILL_GRACE_MS = 300;
const BASE_ENV = { PATH: '/usr/bin:/bin' };
const HAS_BWRAP = process.platform === 'linux' && fs.existsSync(DEFAULT_BWRAP_PATH);

describe.runIf(HAS_BWRAP)('bubblewrap sandbox (real bwrap)', () => {
  let created: string[] = [];
  let spawned: SandboxedProcess[] = [];
  let work = '';
  let outside = '';
  let sandbox: Sandbox;

  const tempDir = (): string => {
    const dir = fs.realpathSync(makeTempDir());
    created.push(dir);
    return dir;
  };

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

  const sh = (script: string, overrides: Partial<SandboxPolicy> = {}): SandboxedProcess => {
    const proc = sandbox.spawn({ argv: ['/bin/sh', '-c', script], cwd: work, env: BASE_ENV }, policy(overrides), new AbortController().signal);
    spawned.push(proc);
    return proc;
  };

  beforeEach(() => {
    work = tempDir();
    outside = tempDir();
    sandbox = createBubblewrapSandbox({ tmpRoot: tempDir(), killGraceMs: KILL_GRACE_MS });
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

  it('writes inside the writable root and refuses to write outside it', async () => {
    const result = await run(sh(`echo ok > inside.txt; echo no > ${outside}/outside.txt`));
    expect(fs.readFileSync(path.join(work, 'inside.txt'), 'utf8')).toBe('ok\n');
    expect(fs.existsSync(path.join(outside, 'outside.txt'))).toBe(false);
    expect(result.code).not.toBe(0);
  });

  it('keeps a write-denied file read-only inside the writable root', async () => {
    const locked = path.join(work, 'locked.txt');
    fs.writeFileSync(locked, 'original');
    await run(sh(`echo changed > ${locked}`, { writeDeniedLiterals: [locked] }));
    expect(fs.readFileSync(locked, 'utf8')).toBe('original');
  });

  it('hides a read-denied directory', async () => {
    const hidden = tempDir();
    fs.writeFileSync(path.join(hidden, 'secret'), 'classified');
    const result = await run(sh(`cat ${hidden}/secret`, { readDenied: [hidden] }));
    expect(result.stdout).not.toContain('classified');
    expect(result.code).not.toBe(0);
  });

  it('has no network interface other than loopback when the network is denied', async () => {
    const result = await run(sh("tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '"));
    expect(result.stdout.trim()).toBe('lo');
  });

  it('gives the command a writable private TMPDIR that is removed afterwards', async () => {
    const result = await run(sh('echo $TMPDIR; touch "$TMPDIR/probe"'));
    const tmp = result.stdout.trim();
    expect(result.code).toBe(0);
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('keeps a protected path that does not exist yet from being created, and removes the placeholder afterwards', async () => {
    const hooks = path.join(work, '.git', 'hooks');
    const result = await run(sh('mkdir .git 2>/dev/null && echo created || echo refused', { writeDeniedLiterals: [hooks] }));
    expect(result.stdout.trim()).toBe('refused');
    expect(fs.existsSync(path.join(work, '.git'))).toBe(false);
  });

  it('keeps that protection for a second command planned while the first command holds the placeholder', async () => {
    const hooks = path.join(work, '.git', 'hooks');
    const gates = [path.join(outside, 'gate-first'), path.join(outside, 'gate-second')];
    for (const gate of gates) execFileSync('/usr/bin/mkfifo', [gate]);
    const first = sh(`: > ${path.join(outside, 'first-ready')}; cat ${gates[0]}`, { writeDeniedLiterals: [hooks] });
    await waitFor(() => fs.existsSync(path.join(outside, 'first-ready')));
    const second = sh(`: > ${path.join(outside, 'second-ready')}; cat ${gates[1]}; mkdir .git 2>/dev/null && echo created || echo refused`, { writeDeniedLiterals: [hooks] });
    await waitFor(() => fs.existsSync(path.join(outside, 'second-ready')));
    fs.writeFileSync(gates[0] as string, 'open');
    await run(first);
    expect(fs.existsSync(path.join(work, '.git'))).toBe(true);
    fs.writeFileSync(gates[1] as string, 'open');
    expect((await run(second)).stdout.trim()).toBe('refused');
    expect(fs.existsSync(path.join(work, '.git'))).toBe(false);
  });

  it('keeps a protected path from being created under the closure of a widening allow rule', async () => {
    const wide = tempDir();
    const fileRules = fileRulesOf([fileSpec(`/${wide}/**`, { roots: [work], home: outside, tool: 'Edit', effect: 'allow' })], [work]);
    const result = await run(sh(`mkdir ${wide}/.git 2>/dev/null && echo created || echo refused; : > ${wide}/other && echo wrote`, { fileRules, writeDeniedLiterals: [path.join(wide, '.git', 'hooks')] }));
    expect(result.stdout.trim().split('\n')).toEqual(['refused', 'wrote']);
    expect(fs.existsSync(path.join(wide, '.git'))).toBe(false);
  });

  describe('a symlinked protected .git (the run settles whether a symlink can be pinned)', () => {
    const START_REFUSED = 'start-refused';

    const outcome = async (script: string, git: string): Promise<string> => {
      try {
        const proc = sh(script, { writeDeniedLiterals: [git] });
        return (await run(proc)).stdout.trim();
      } catch (error) {
        if (error instanceof SandboxPolicyError) return START_REFUSED;
        throw error;
      }
    };

    const withLink = (target: string): string => {
      const git = path.join(work, '.git');
      fs.mkdirSync(path.join(work, target), { recursive: true });
      fs.symlinkSync(target, git);
      return git;
    };

    it('either refuses to start or does not let .git be replaced by a directory', async () => {
      const git = withLink('realgit');
      expect(['kept', START_REFUSED]).toContain(await outcome('rm .git 2>/dev/null && mkdir -p .git/hooks 2>/dev/null && echo replaced || echo kept', git));
      expect(fs.lstatSync(git).isSymbolicLink()).toBe(true);
    });

    it('either refuses to start or does not let .git be re-pointed', async () => {
      const git = withLink('realgit');
      fs.mkdirSync(path.join(work, 'other'));
      expect(['kept', START_REFUSED]).toContain(await outcome('ln -sfn other .git 2>/dev/null && echo repointed || echo kept', git));
      expect(fs.readlinkSync(git)).toBe('realgit');
    });

    it('either refuses to start or keeps a looped .git a loop', async () => {
      const git = path.join(work, '.git');
      fs.symlinkSync('.git', git);
      expect(['kept', START_REFUSED]).toContain(await outcome('rm .git 2>/dev/null && mkdir -p .git/hooks 2>/dev/null && echo replaced || echo kept', git));
      expect(fs.lstatSync(git).isSymbolicLink()).toBe(true);
    });

    it('either refuses to start or lets a hand-made .git -> ../store/x.git work as a repository path without being replaceable', async () => {
      const store = path.join(outside, 'x.git');
      fs.mkdirSync(path.join(store, 'hooks'), { recursive: true });
      const git = path.join(work, '.git');
      fs.symlinkSync(store, git);
      const result = await outcome('rm .git 2>/dev/null && echo replaced || echo kept', git);
      expect(['kept', START_REFUSED]).toContain(result);
      expect(fs.lstatSync(git).isSymbolicLink()).toBe(true);
    });
  });

  it('terminates the whole process group when aborted', async () => {
    const controller = new AbortController();
    const proc = sandbox.spawn({ argv: ['/bin/sh', '-c', 'sleep 30 & sleep 30'], cwd: work, env: BASE_ENV }, policy(), controller.signal);
    spawned.push(proc);
    controller.abort();
    const exit = await proc.exited;
    expect(exit.killedBy).toBe('abort');
  });
});
