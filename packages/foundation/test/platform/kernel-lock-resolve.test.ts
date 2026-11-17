import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveKernelLock } from '../../src/platform/kernel-lock.ts';
import { createLockCapability } from '../../src/platform/lock-capability.ts';
import type { KernelLockMechanism } from '../../src/platform/kernel-lock.ts';
import { makeTemporaryDirectory } from '../support/temporary-directory.ts';
import { fixedCapability } from '../support/probe-fakes.ts';

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'platform', 'kernel-lock.ts');

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;

const pretendPlatform = (platform: string): void => {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: platform });
};

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
});

describe('T10 call locks use the lock proof, not the platform name', () => {
  it('resolves the BSD-flag file lock for a proved directory on any platform value', async () => {
    const dir = makeTemporaryDirectory();
    for (const platform of ['linux', 'win32', 'freebsd', 'darwin']) {
      pretendPlatform(platform);
      expect((await resolveKernelLock(dir, { capability: fixedCapability('proved') })).name).toBe('file-lock');
    }
  });

  it.for(['unenforced', 'unmeasured'] as const)('resolves the SQLite lock for a %s directory, also on a darwin-like host', async (answer) => {
    const dir = makeTemporaryDirectory();
    pretendPlatform('darwin');
    expect((await resolveKernelLock(dir, { capability: fixedCapability(answer) })).name).toBe('sqlite-lock');
  });

  it('kernel-lock.ts chooses by no platform name', () => {
    const text = fs.readFileSync(SOURCE, 'utf8');
    expect(text).not.toMatch(/case 'darwin'|process\.platform/);
  });

  it('a real claim goes through the mechanism the host proof selects: its claim holds and a second claim is held', async () => {
    const dir = makeTemporaryDirectory();
    const capability = createLockCapability({ proofDir: makeTemporaryDirectory() });
    await capability.of(dir);
    const mechanism: KernelLockMechanism = resolveKernelLock(dir, { capability });
    const lockPath = path.join(dir, 'call.lock');
    expect(await mechanism.isHeld(lockPath)).toBe(false);
    const first = await mechanism.claim(lockPath);
    expect(first.kind).toBe('claimed');
    expect(await mechanism.isHeld(lockPath)).toBe(true);
    expect((await mechanism.claim(lockPath)).kind).toBe('held');
    if (first.kind === 'claimed') first.lock.release();
    expect(await mechanism.isHeld(lockPath)).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
  });
});
