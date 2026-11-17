import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FileLockUnavailableError, createFileLock, kernelLockNamed, nodeFileLockOps, resolveKernelLock } from '../../src/platform/kernel-lock.ts';
import type { KernelLockMechanism } from '../../src/platform/kernel-lock.ts';
import { HOST_PLATFORM, openLockFlagsOn } from '../../src/platform/open-lock-flags.ts';
import { makeTemporaryDirectory } from '../support/temporary-directory.ts';
import { fixedCapability } from '../support/probe-fakes.ts';

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'platform', 'kernel-lock.ts');

const HOST_DEFINES_FLAGS = openLockFlagsOn(HOST_PLATFORM) !== undefined;

const expectCallLockContract = async (mechanism: KernelLockMechanism, dir: string): Promise<void> => {
  const lockPath = path.join(dir, 'call.lock');
  expect(await mechanism.isHeld(lockPath)).toBe(false);
  const first = await mechanism.claim(lockPath);
  expect(first.kind).toBe('claimed');
  expect(await mechanism.isHeld(lockPath)).toBe(true);
  if (first.kind === 'claimed') first.lock.release();
  expect(await mechanism.isHeld(lockPath)).toBe(false);
  expect(fs.existsSync(dir)).toBe(true);
};

describe('T10 call locks use the lock proof, not the platform name', () => {
  it('resolves the file lock for a proved directory on a host that defines the open flags', () => {
    const dir = makeTemporaryDirectory();
    expect(resolveKernelLock(dir, { capability: fixedCapability('proved'), platform: 'darwin' }).name).toBe('file-lock');
  });

  it.for(['linux', 'win32'] as const)('refuses the file lock for a proved directory on %s, which does not define the open flags', (platform) => {
    const dir = makeTemporaryDirectory();
    expect(() => resolveKernelLock(dir, { capability: fixedCapability('proved'), platform })).toThrow(FileLockUnavailableError);
  });

  it.for(['unenforced', 'unmeasured'] as const)('resolves the SQLite lock for a %s directory, also on a darwin host', (answer) => {
    const dir = makeTemporaryDirectory();
    expect(resolveKernelLock(dir, { capability: fixedCapability(answer), platform: 'darwin' }).name).toBe('sqlite-lock');
  });

  it('kernel-lock.ts chooses by no platform name', () => {
    const text = fs.readFileSync(SOURCE, 'utf8');
    expect(text).not.toMatch(/case 'darwin'|process\.platform/);
  });

  it('a file lock is not built on a host without the open flags: a typed refusal, not a lock that never locks', () => {
    expect(() => createFileLock(nodeFileLockOps, 'linux')).toThrow(FileLockUnavailableError);
  });

  it('the file lock of this host is built only where this host defines the open flags', () => {
    if (HOST_DEFINES_FLAGS) expect(kernelLockNamed('file-lock').name).toBe('file-lock');
    else expect(() => kernelLockNamed('file-lock')).toThrow(FileLockUnavailableError);
  });

  it('the call-lock contract holds with the mechanism resolved for an unenforced directory', async () => {
    const dir = makeTemporaryDirectory();
    await expectCallLockContract(resolveKernelLock(dir, { capability: fixedCapability('unenforced') }), dir);
  });

  it('the call-lock contract holds with the file lock for a proved directory where the host defines the open flags, and a proved directory is refused where it does not', async () => {
    const dir = makeTemporaryDirectory();
    if (!HOST_DEFINES_FLAGS) {
      expect(() => resolveKernelLock(dir, { capability: fixedCapability('proved') })).toThrow(FileLockUnavailableError);
      return;
    }
    await expectCallLockContract(resolveKernelLock(dir, { capability: fixedCapability('proved') }), dir);
  });
});
