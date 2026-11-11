import { spawnSync } from '@momonga/testkit/child-process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeatbeltSandbox, createUnsandboxed } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup, testKernelLock, TEST_CHILD_UNPROTECTED } from '@momonga/testkit';
import { makeTempDir, run } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const BASE_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
const REFUSED_CACHE_WRITE = /^[A-Za-z][A-Za-z0-9._+-]*: error: couldn't create cache file '[^'\n]*\/xcrun_db-[A-Za-z0-9]{8}' \(errno=Operation not permitted\)$/;

const outputOf = (command: string, args: string[]): string => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

describe.runIf(process.platform === 'darwin')('seatbelt keeps the xcrun cache unwritable (real sandbox-exec)', () => {
  let created: string[] = [];
  let spawned: SandboxedProcess[] = [];
  let root = '';
  let sandbox: Sandbox;
  const unsandboxed = createUnsandboxed({ protection: TEST_CHILD_UNPROTECTED, platform: process.platform });

  const policy = (): SandboxPolicy => ({ writableRoots: [root], writeDenied: [], protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], fileRules: EMPTY_FILE_RULES, readDenied: [], network: 'deny' });

  const sh = async (using: Sandbox, script: string, env: Record<string, string>): Promise<SandboxedProcess> => {
    const proc = using.spawn({ argv: ['/bin/sh', '-c', script], cwd: root, env }, policy(), new AbortController().signal);
    spawned.push(await proc);
    return await proc;
  };

  beforeEach(() => {
    root = makeTempDir();
    const tmpRoot = makeTempDir();
    created.push(root, tmpRoot);
    sandbox = createSeatbeltSandbox({ lock: testKernelLock(), tmpRoot, killGraceMs: 300 });
  });

  afterEach(async () => {
    try {
      await killGroupsForCleanup(spawned.map((proc) => proc.pgid));
    } finally {
      spawned = [];
      for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
      created = [];
    }
  });

  it('a tool run through the shim on a forced cache miss ends as it does unsandboxed and differs only by the refused cache write', async () => {
    const env = { ...BASE_ENV, SDKROOT: path.join(root, `no-sdk-${crypto.randomUUID()}`) };
    const confined = await run(await sh(sandbox, '/usr/bin/xcrun --find ls', env));
    const plain = await run(await sh(unsandboxed, '/usr/bin/xcrun --find ls', env));
    expect(confined.code).toBe(plain.code);
    expect(confined.stdout).toBe(plain.stdout);
    const plainLines = plain.stderr.split('\n');
    const confinedLines = confined.stderr.split('\n');
    const refused = confinedLines.filter((line) => REFUSED_CACHE_WRITE.test(line));
    expect(refused.length).toBeGreaterThan(0);
    expect(plainLines.some((line) => REFUSED_CACHE_WRITE.test(line))).toBe(false);
    expect(confinedLines.filter((line) => !REFUSED_CACHE_WRITE.test(line))).toEqual(plainLines);
  });

  it('a sandboxed command cannot create xcrun_db-<random> in the Darwin user temp directory, while an unsandboxed one can', async () => {
    const darwinTemp = outputOf('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR']);
    const target = path.join(darwinTemp, `xcrun_db-${crypto.randomBytes(6).toString('hex')}`);
    try {
      const confined = await run(await sh(sandbox, `: > '${target}'`, BASE_ENV));
      expect(confined.code).not.toBe(0);
      expect(confined.stderr).toContain('Operation not permitted');
      expect(fs.existsSync(target)).toBe(false);
      const plain = await run(await sh(unsandboxed, `: > '${target}'`, BASE_ENV));
      expect(plain.code).toBe(0);
      expect(fs.existsSync(target)).toBe(true);
    } finally {
      fs.rmSync(target, { force: true });
    }
  });
});
