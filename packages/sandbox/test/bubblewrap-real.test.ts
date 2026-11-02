import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { DEFAULT_BWRAP_PATH, createBubblewrapSandbox } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { killGroupsForCleanup } from '@momonga/testkit';
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

  it('terminates the whole process group when aborted', async () => {
    const controller = new AbortController();
    const proc = sandbox.spawn({ argv: ['/bin/sh', '-c', 'sleep 30 & sleep 30'], cwd: work, env: BASE_ENV }, policy(), controller.signal);
    spawned.push(proc);
    controller.abort();
    const exit = await proc.exited;
    expect(exit.killedBy).toBe('abort');
  });
});
