import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { createUnsandboxed } from '@momonga/sandbox';
import type { SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, TEST_CHILD_UNPROTECTED, afterMicrotasks, killGroupsForCleanup } from '@momonga/testkit';
import { makeTempDir } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const BASE_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

describe('a sandboxed process moved to another owner', () => {
  const spawned: SandboxedProcess[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await killGroupsForCleanup(spawned.splice(0).map((child) => child.pgid));
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('is no longer stopped by the signal it was started with, and is stopped by the signal it was moved to', async () => {
    const root = makeTempDir();
    roots.push(root);
    const policy: SandboxPolicy = { writableRoots: [root], writeDenied: [], protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], fileRules: EMPTY_FILE_RULES, readDenied: [], network: 'deny' };
    const sandbox = createUnsandboxed({ protection: TEST_CHILD_UNPROTECTED, platform: process.platform, killGraceMs: 300 });
    const started = new AbortController();
    const child = await sandbox.spawn({ argv: ['/bin/sh', '-c', 'exec sleep 30'], cwd: root, env: BASE_ENV }, policy, started.signal);
    spawned.push(child);
    const owner = new AbortController();
    child.rebind(owner.signal);
    started.abort();
    let ended = false;
    void child.exited.then(() => {
      ended = true;
    });
    for (let turn = 0; turn < 50; turn += 1) await afterMicrotasks();
    expect(ended).toBe(false);
    expect(groupAlive(child.pgid)).toBe(true);
    owner.abort();
    expect(await child.exited).toMatchObject({ killedBy: 'abort' });
  });

  it('is stopped at once when the signal it is moved to has already fired', async () => {
    const root = makeTempDir();
    roots.push(root);
    const policy: SandboxPolicy = { writableRoots: [root], writeDenied: [], protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], fileRules: EMPTY_FILE_RULES, readDenied: [], network: 'deny' };
    const sandbox = createUnsandboxed({ protection: TEST_CHILD_UNPROTECTED, platform: process.platform, killGraceMs: 300 });
    const child = await sandbox.spawn({ argv: ['/bin/sh', '-c', 'exec sleep 30'], cwd: root, env: BASE_ENV }, policy, new AbortController().signal);
    spawned.push(child);
    child.rebind(AbortSignal.abort());
    expect(await child.exited).toMatchObject({ killedBy: 'abort' });
  });
});
