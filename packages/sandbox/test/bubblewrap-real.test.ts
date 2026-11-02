import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { DEFAULT_BWRAP_PATH, createBubblewrapSandbox, createPlaceholderJournal } from '@momonga/sandbox';
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
    sandbox = createBubblewrapSandbox({ tmpRoot: tempDir(), killGraceMs: KILL_GRACE_MS, journal: createPlaceholderJournal(path.join(tempDir(), 'journal')) });
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

  it('has no route through any interface other than loopback when the network is denied', async () => {
    const result = await run(sh("awk 'FILENAME == \"/proc/net/route\" && FNR > 1 { print $1 } FILENAME == \"/proc/net/ipv6_route\" { print $10 }' /proc/net/route /proc/net/ipv6_route | grep -vc '^lo$'"));
    expect(result.stdout.trim()).toBe('0');
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
    const signalling = { writableRoots: [work, outside], writeDeniedLiterals: [hooks] };
    const first = sh(`: > ${path.join(outside, 'first-ready')}; cat ${gates[0]}`, signalling);
    await waitFor(() => fs.existsSync(path.join(outside, 'first-ready')));
    const second = sh(`: > ${path.join(outside, 'second-ready')}; cat ${gates[1]} > /dev/null; mkdir .git 2>/dev/null && echo created || echo refused`, signalling);
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

  describe('replacing, moving and writing a protected entry that exists', () => {
    const protectedDirectory = (): string => {
      const hooks = path.join(work, '.git', 'hooks');
      fs.mkdirSync(hooks, { recursive: true });
      fs.writeFileSync(path.join(hooks, 'pre-commit'), 'original');
      return hooks;
    };

    it.each([
      ['rm -rf .git/hooks', 'rm -rf .git/hooks'],
      ['mv .git/hooks aside', 'mv .git/hooks aside'],
      ['mv .git aside', 'mv .git aside'],
      ['rm -rf .git', 'rm -rf .git'],
      ['writing a hook', 'printf x > .git/hooks/post-commit'],
      ['replacing a hook', 'printf x > .git/hooks/pre-commit'],
    ])('keeps the protected directory in place: %s', async (_label, script) => {
      const hooks = protectedDirectory();
      await run(sh(script, { writeDeniedLiterals: [hooks] }));
      expect(fs.readFileSync(path.join(hooks, 'pre-commit'), 'utf8')).toBe('original');
      expect(fs.readdirSync(hooks)).toEqual(['pre-commit']);
    });

    it.each([
      ['rm locked.txt', 'rm locked.txt'],
      ['mv locked.txt aside', 'mv locked.txt aside'],
      ['truncating it', ': > locked.txt'],
      ['appending to it', 'printf x >> locked.txt'],
    ])('keeps the protected file in place: %s', async (_label, script) => {
      const locked = path.join(work, 'locked.txt');
      fs.writeFileSync(locked, 'original');
      await run(sh(script, { writeDeniedLiterals: [locked] }));
      expect(fs.readFileSync(locked, 'utf8')).toBe('original');
      expect(fs.existsSync(locked)).toBe(true);
    });
  });

  describe('a protected link name', () => {
    const spawnFor = (git: string) => () => sh('true', { writeDeniedLiterals: [git] });

    it.each([
      ['a link to a directory in the root', (git: string) => fs.symlinkSync('realgit', git)],
      ['a link to a directory outside the root', (git: string) => fs.symlinkSync(path.join(outside, 'x.git'), git)],
      ['a link to itself', (git: string) => fs.symlinkSync('.git', git)],
    ] as const)('refuses to start when the writable root holds %s', (_label, make) => {
      fs.mkdirSync(path.join(work, 'realgit'), { recursive: true });
      fs.mkdirSync(path.join(outside, 'x.git'), { recursive: true });
      const git = path.join(work, '.git');
      make(git);
      expect(spawnFor(git)).toThrow(expect.objectContaining({ code: 'protected_link_not_pinnable', path: git }));
      expect(fs.lstatSync(git).isSymbolicLink()).toBe(true);
    });

    it('starts when the link lies outside every writable area, where the read-only root already pins it', async () => {
      const git = path.join(outside, 'link');
      fs.symlinkSync('elsewhere', git);
      const result = await run(sh(`ln -sfn other ${git} 2>/dev/null && echo repointed || echo kept; rm ${git} 2>/dev/null && echo removed || echo kept`, { writeDeniedLiterals: [git] }));
      expect(result.stdout.trim().split('\n')).toEqual(['kept', 'kept']);
      expect(fs.readlinkSync(git)).toBe('elsewhere');
    });

    it('refuses to start for a looped link on the way to a protected path inside the root', () => {
      fs.symlinkSync('.git', path.join(work, '.git'));
      expect(() => sh('true', { writeDeniedLiterals: [path.join(work, '.git', 'hooks')] })).toThrow(expect.objectContaining({ code: 'protected_path_unreadable' }));
    });
  });

  describe('a symlink name cannot be pinned by real bwrap (measured, bubblewrap 0.8)', () => {
    const bwrapIn = (arrange: readonly string[], script: string): string => {
      const git = path.join(work, '.git');
      fs.mkdirSync(path.join(work, 'realgit', 'hooks'), { recursive: true });
      fs.mkdirSync(path.join(work, 'src'));
      fs.symlinkSync('realgit', git);
      return execFileSync(DEFAULT_BWRAP_PATH, ['--unshare-pid', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', ...arrange, '--chdir', work, '/bin/sh', '-c', script], {
        encoding: 'utf8',
        env: BASE_ENV,
      });
    };

    it('a read-only bind of the link name binds the target and leaves the name replaceable', () => {
      const git = path.join(work, '.git');
      const output = bwrapIn(['--bind', work, work, '--ro-bind', git, git], 'rm .git && mkdir .git && echo replaced; true > realgit/hooks/x 2>/dev/null && echo target-writable || echo target-pinned');
      expect(output.trim().split('\n')).toEqual(['replaced', 'target-pinned']);
    });

    it('a read-only parent pins the name only by refusing every new entry in the parent', () => {
      const output = bwrapIn(
        ['--ro-bind', work, work, '--bind', path.join(work, 'src'), path.join(work, 'src')],
        'rm .git 2>/dev/null && echo replaced || echo kept; true > created 2>/dev/null && echo created || echo creation-refused; true > src/inside && echo inside-ok',
      );
      expect(output.trim().split('\n')).toEqual(['kept', 'creation-refused', 'inside-ok']);
    });
  });

  describe('the placeholder of a protected path that does not exist yet', () => {
    const hooks = (): string => path.join(work, '.git', 'hooks');

    it('is removed when the process holding it is killed with SIGKILL', async () => {
      const gate = path.join(outside, 'gate');
      execFileSync('/usr/bin/mkfifo', [gate]);
      const held = sh(`: > ${path.join(outside, 'ready')}; cat ${gate} > /dev/null`, { writableRoots: [work, outside], writeDeniedLiterals: [hooks()] });
      await waitFor(() => fs.existsSync(path.join(outside, 'ready')));
      expect(fs.existsSync(path.join(work, '.git'))).toBe(true);
      process.kill(-held.pgid, 'SIGKILL');
      const exit = await held.exited;
      expect(exit.signal).toBe('SIGKILL');
      expect(fs.existsSync(path.join(work, '.git'))).toBe(false);
    });

    it('stays while another process still holds it after the first one is killed, and protects until then', async () => {
      const gates = [path.join(outside, 'gate-first'), path.join(outside, 'gate-second')];
      for (const gate of gates) execFileSync('/usr/bin/mkfifo', [gate]);
      const signalling = { writableRoots: [work, outside], writeDeniedLiterals: [hooks()] };
      const first = sh(`: > ${path.join(outside, 'first-ready')}; cat ${gates[0]} > /dev/null`, signalling);
      await waitFor(() => fs.existsSync(path.join(outside, 'first-ready')));
      const second = sh(`: > ${path.join(outside, 'second-ready')}; cat ${gates[1]} > /dev/null; mkdir .git 2>/dev/null && echo created || echo refused`, signalling);
      await waitFor(() => fs.existsSync(path.join(outside, 'second-ready')));
      process.kill(-first.pgid, 'SIGKILL');
      await first.exited;
      expect(fs.existsSync(path.join(work, '.git'))).toBe(true);
      fs.writeFileSync(gates[1] as string, 'open');
      expect((await run(second)).stdout.trim()).toBe('refused');
      expect(fs.existsSync(path.join(work, '.git'))).toBe(false);
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
