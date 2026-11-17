import { execFileSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, groupTerminationBoundMs } from '@momonga/foundation';
import { DEFAULT_BWRAP_PATH, createBubblewrapSandbox, createPlaceholderJournal, heldMountPoints } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup, waitFor, testKernelLock } from '@momonga/testkit';
import { fileRulesOf, fileSpec } from './file-rule-specs.ts';
import { makeTempDir, run } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

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

  const newSandbox = (): Sandbox =>
    createBubblewrapSandbox({ lock: testKernelLock(), tmpRoot: tempDir(), killGraceMs: KILL_GRACE_MS, journal: createPlaceholderJournal(path.join(tempDir(), 'journal')), holders: heldMountPoints });

  const sh = async (script: string, overrides: Partial<SandboxPolicy> = {}): Promise<SandboxedProcess> => {
    const proc = await sandbox.spawn({ argv: ['/bin/sh', '-c', script], cwd: work, env: BASE_ENV }, policy(overrides), new AbortController().signal);
    spawned.push(proc);
    return proc;
  };

  beforeEach(() => {
    work = tempDir();
    outside = tempDir();
    sandbox = newSandbox();
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
    const result = await run(await sh(`echo ok > inside.txt; echo no > ${outside}/outside.txt`));
    expect(fs.readFileSync(path.join(work, 'inside.txt'), 'utf8')).toBe('ok\n');
    expect(fs.existsSync(path.join(outside, 'outside.txt'))).toBe(false);
    expect(result.code).not.toBe(0);
  });

  it('keeps a write-denied file read-only inside the writable root', async () => {
    const locked = path.join(work, 'locked.txt');
    fs.writeFileSync(locked, 'original');
    await run(await sh(`echo changed > ${locked}`, { writeDeniedLiterals: [locked] }));
    expect(fs.readFileSync(locked, 'utf8')).toBe('original');
  });

  it('hides a read-denied directory', async () => {
    const hidden = tempDir();
    fs.writeFileSync(path.join(hidden, 'secret'), 'classified');
    const result = await run(await sh(`cat ${hidden}/secret`, { readDenied: [hidden] }));
    expect(result.stdout).not.toContain('classified');
    expect(result.code).not.toBe(0);
  });

  it('has no route through any interface other than loopback when the network is denied', async () => {
    const result = await run(await sh("awk 'FILENAME == \"/proc/net/route\" && FNR > 1 { print $1 } FILENAME == \"/proc/net/ipv6_route\" { print $10 }' /proc/net/route /proc/net/ipv6_route | grep -vc '^lo$'"));
    expect(result.stdout.trim()).toBe('0');
  });

  it('gives the command a writable private TMPDIR that is removed afterwards', async () => {
    const result = await run(await sh('echo $TMPDIR; touch "$TMPDIR/probe"'));
    const tmp = result.stdout.trim();
    expect(result.code).toBe(0);
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('keeps a protected path that does not exist yet from being created, and removes the placeholder afterwards', async () => {
    const hooks = path.join(work, '.git', 'hooks');
    const result = await run(await sh('mkdir .git 2>/dev/null && echo created || echo refused', { writeDeniedLiterals: [hooks] }));
    expect(result.stdout.trim()).toBe('refused');
    expect(fs.existsSync(path.join(work, '.git'))).toBe(false);
  });

  it('keeps that protection for a second command planned while the first command holds the placeholder', async () => {
    const hooks = path.join(work, '.git', 'hooks');
    const gates = [path.join(outside, 'gate-first'), path.join(outside, 'gate-second')];
    for (const gate of gates) execFileSync('/usr/bin/mkfifo', [gate]);
    const signalling = { writableRoots: [work, outside], writeDeniedLiterals: [hooks] };
    const first = await sh(`: > ${path.join(outside, 'first-ready')}; cat ${gates[0]}`, signalling);
    await waitFor(() => fs.existsSync(path.join(outside, 'first-ready')));
    const second = await sh(`: > ${path.join(outside, 'second-ready')}; cat ${gates[1]} > /dev/null; mkdir .git 2>/dev/null && echo created || echo refused`, signalling);
    await waitFor(() => fs.existsSync(path.join(outside, 'second-ready')));
    fs.writeFileSync(gates[0] as string, 'open');
    await run(await first);
    expect(fs.existsSync(path.join(work, '.git'))).toBe(true);
    fs.writeFileSync(gates[1] as string, 'open');
    expect((await run(await second)).stdout.trim()).toBe('refused');
    expect(fs.existsSync(path.join(work, '.git'))).toBe(false);
  });

  it('keeps a protected path from being created under the closure of a widening allow rule', async () => {
    const wide = tempDir();
    const fileRules = await fileRulesOf([fileSpec(`/${wide}/**`, { roots: [work], home: outside, tool: 'Edit', effect: 'allow' })], [work]);
    const result = await run(await sh(`mkdir ${wide}/.git 2>/dev/null && echo created || echo refused; : > ${wide}/other && echo wrote`, { fileRules: await fileRules, writeDeniedLiterals: [path.join(wide, '.git', 'hooks')] }));
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
      await run(await sh(script, { writeDeniedLiterals: [hooks] }));
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
      await run(await sh(script, { writeDeniedLiterals: [locked] }));
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
    ] as const)('refuses to start when the writable root holds %s', async (_label, make) => {
      fs.mkdirSync(path.join(work, 'realgit'), { recursive: true });
      fs.mkdirSync(path.join(outside, 'x.git'), { recursive: true });
      const git = path.join(work, '.git');
      make(git);
      await expect(spawnFor(git)()).rejects.toThrow(expect.objectContaining({ code: 'protected_link_not_pinnable', path: git }));
      expect(fs.lstatSync(git).isSymbolicLink()).toBe(true);
    });

    it('starts when the link lies outside every writable area, where the read-only root already pins it', async () => {
      const git = path.join(outside, 'link');
      fs.symlinkSync('elsewhere', git);
      const result = await run(await sh(`ln -sfn other ${git} 2>/dev/null && echo repointed || echo kept; rm ${git} 2>/dev/null && echo removed || echo kept`, { writeDeniedLiterals: [git] }));
      expect(result.stdout.trim().split('\n')).toEqual(['kept', 'kept']);
      expect(fs.readlinkSync(git)).toBe('elsewhere');
    });

    it('refuses to start for a looped link on the way to a protected path inside the root', async () => {
      fs.symlinkSync('.git', path.join(work, '.git'));
      await expect(sh('true', { writeDeniedLiterals: [path.join(work, '.git', 'hooks')] })).rejects.toThrow(expect.objectContaining({ code: 'protected_path_unreadable' }));
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
      const held = await sh(`: > ${path.join(outside, 'ready')}; cat ${gate} > /dev/null`, { writableRoots: [work, outside], writeDeniedLiterals: [hooks()] });
      await waitFor(() => fs.existsSync(path.join(outside, 'ready')));
      expect(fs.existsSync(path.join(work, '.git'))).toBe(true);
      process.kill(-(await held).pgid, 'SIGKILL');
      const exit = await (await held).exited;
      expect(exit.signal).toBe('SIGKILL');
      expect(fs.existsSync(path.join(work, '.git'))).toBe(false);
    });

    it('is not unlinked under a second sandbox that still holds it: the second sandbox keeps refusing a write to the name', async () => {
      const mcp = path.join(work, '.mcp.json');
      const second = newSandbox();
      const gates = [path.join(outside, 'gate-a'), path.join(outside, 'gate-b')];
      for (const gate of gates) execFileSync('/usr/bin/mkfifo', [gate]);
      const signalling = { writableRoots: [work, outside], writeDenied: [mcp] };
      const first = await sh(`: > ${path.join(outside, 'a-ready')}; cat ${gates[0]} > /dev/null`, signalling);
      await waitFor(() => fs.existsSync(path.join(outside, 'a-ready')));
      expect(fs.statSync(mcp).isFile()).toBe(true);
      const holder = second.spawn(
        { argv: ['/bin/sh', '-c', `: > ${path.join(outside, 'b-ready')}; cat ${gates[1]} > /dev/null; (echo x > ${mcp}) 2>/dev/null && echo wrote || echo refused`], cwd: work, env: BASE_ENV },
        policy(signalling),
        new AbortController().signal,
      );
      spawned.push(await holder);
      await waitFor(() => fs.existsSync(path.join(outside, 'b-ready')));
      fs.writeFileSync(gates[0] as string, 'open');
      await run(await first);
      expect(fs.existsSync(mcp)).toBe(true);
      fs.writeFileSync(gates[1] as string, 'open');
      expect((await run(await holder)).stdout.trim()).toBe('refused');
      await run(await sh('true', { writableRoots: [work, outside], writeDenied: [path.join(work, '.envrc')] }));
      expect(fs.existsSync(mcp)).toBe(false);
    });

    it('stays while another process still holds it after the first one is killed, and protects until then', async () => {
      const gates = [path.join(outside, 'gate-first'), path.join(outside, 'gate-second')];
      for (const gate of gates) execFileSync('/usr/bin/mkfifo', [gate]);
      const signalling = { writableRoots: [work, outside], writeDeniedLiterals: [hooks()] };
      const first = await sh(`: > ${path.join(outside, 'first-ready')}; cat ${gates[0]} > /dev/null`, signalling);
      await waitFor(() => fs.existsSync(path.join(outside, 'first-ready')));
      const second = await sh(`: > ${path.join(outside, 'second-ready')}; cat ${gates[1]} > /dev/null; mkdir .git 2>/dev/null && echo created || echo refused`, signalling);
      await waitFor(() => fs.existsSync(path.join(outside, 'second-ready')));
      process.kill(-(await first).pgid, 'SIGKILL');
      await (await first).exited;
      expect(fs.existsSync(path.join(work, '.git'))).toBe(true);
      fs.writeFileSync(gates[1] as string, 'open');
      expect((await run(await second)).stdout.trim()).toBe('refused');
      expect(fs.existsSync(path.join(work, '.git'))).toBe(false);
    });
  });

  it('terminates the whole process group when aborted', async () => {
    const controller = new AbortController();
    const ready = path.join(work, 'ready');
    const proc = await sandbox.spawn({ argv: ['/bin/sh', '-c', `: > ${ready}; sleep 30 & sleep 30`], cwd: work, env: BASE_ENV }, policy(), controller.signal);
    spawned.push(proc);
    await waitFor(() => fs.existsSync(ready), { description: 'the command is running' });
    controller.abort();
    const exit = await (await proc).exited;
    expect(exit.killedBy).toBe('abort');
  });

  it('ends the whole process group within the stop bound when aborted just after spawn, whatever step ends it', async () => {
    const controller = new AbortController();
    const proc = await sandbox.spawn({ argv: ['/bin/sh', '-c', 'sleep 30 & sleep 30'], cwd: work, env: BASE_ENV }, policy(), controller.signal);
    spawned.push(proc);
    const abortedAt = Date.now();
    controller.abort();
    const exit = await (await proc).exited;
    expect(Date.now() - abortedAt).toBeLessThanOrEqual(groupTerminationBoundMs(KILL_GRACE_MS));
    expect(exit.stop).toBe('confirmed');
  });

  it('gives a running command that ignores SIGTERM the whole kill grace, because bwrap itself, which would end the sandbox at once, is not sent SIGTERM', async () => {
    const controller = new AbortController();
    const ready = path.join(work, 'ready');
    const proc = await sandbox.spawn({ argv: ['/bin/sh', '-c', `trap '' TERM; : > ${ready}; sleep 30`], cwd: work, env: BASE_ENV }, policy(), controller.signal);
    spawned.push(proc);
    await waitFor(() => fs.existsSync(ready), { description: 'the command is running' });
    const abortedAt = Date.now();
    controller.abort();
    const exit = await (await proc).exited;
    expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(KILL_GRACE_MS);
    expect(exit.killedBy).toBe('grace-kill');
  });

  it('sends SIGTERM to a running command, which bwrap reports as exit code 143', async () => {
    const controller = new AbortController();
    const ready = path.join(work, 'ready');
    const proc = await sandbox.spawn({ argv: ['/bin/sh', '-c', `: > ${ready}; sleep 30`], cwd: work, env: BASE_ENV }, policy(), controller.signal);
    spawned.push(proc);
    await waitFor(() => fs.existsSync(ready), { description: 'the command is running' });
    const abortedAt = Date.now();
    controller.abort();
    const exit = await (await proc).exited;
    expect(Date.now() - abortedAt).toBeLessThan(KILL_GRACE_MS);
    expect(exit).toMatchObject({ code: 143, signal: null, killedBy: 'abort' });
  });
});
