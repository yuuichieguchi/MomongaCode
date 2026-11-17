import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { kernelLockNamed, lockFormOf, sidecarOf } from '@momonga/foundation';
import type { KernelLockMechanism } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, registerCleanup, withTempDir } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const MECHANISMS: readonly KernelLockMechanism['name'][] = ['file-lock', 'sqlite-lock'];

const lockFileOf = (mechanism: KernelLockMechanism, entry: string): string =>
  lockFormOf(mechanism, 'file') === 'entry' ? entry : sidecarOf(mechanism, entry);

describe.each(MECHANISMS)('the kernel lock contract of %s', (name) => {
  const mechanism = kernelLockNamed(name);

  it('keeps the lock file after release, frees the lock, and lets the next claim take it', async (context) => {
    const entry = path.join(withTempDir(context), 'runtime.lock');
    const outcome = await mechanism.claim(entry);
    if (outcome.kind !== 'claimed') throw new Error('the lock was not free');
    outcome.lock.release();
    expect(fs.existsSync(lockFileOf(mechanism, entry))).toBe(true);
    expect(await mechanism.isHeld(entry)).toBe(false);
    const again = await mechanism.claim(entry);
    expect(again.kind).toBe('claimed');
    if (again.kind === 'claimed') registerCleanup(context, () => again.lock.release());
  });

  it('removes the lock file and the holder text it wrote on dispose, and leaves nothing else in the directory', async (context) => {
    const dir = withTempDir(context);
    const entry = path.join(dir, 'runtime.lock');
    const outcome = await mechanism.claim(entry);
    if (outcome.kind !== 'claimed') throw new Error('the lock was not free');
    outcome.lock.writeHolder('4242');
    outcome.lock.dispose();
    expect(fs.existsSync(lockFileOf(mechanism, entry))).toBe(false);
    expect(await mechanism.isHeld(entry)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
