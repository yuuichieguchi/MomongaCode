import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { LockAdoptionError } from '@momonga/foundation';
import type { HeldKernelLock, KernelLockMechanism } from '@momonga/foundation';
import { withTempDir } from '../../src/index.ts';

const claimed = async (mechanism: KernelLockMechanism, lockPath: string): Promise<HeldKernelLock> => {
  const outcome = await mechanism.claim(lockPath);
  if (outcome.kind !== 'claimed') throw new Error(`${lockPath} was not claimed`);
  return outcome.lock;
};

export const kernelLockContract = (make: () => KernelLockMechanism): void => {
  it('offers inheritance exactly when it is the file lock', () => {
    const mechanism = make();
    expect(mechanism.claimInheritable !== undefined).toBe(mechanism.name === 'file-lock');
    expect(mechanism.adoptInherited !== undefined).toBe(mechanism.name === 'file-lock');
  });

  it('refuses a claim in a folder that does not exist', async (context) => {
    const root = withTempDir(context);
    await expect(make().claim(path.join(root, 'missing', 'a.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('answers held to a second claim while the first holds, and claims again after the release', async (context) => {
    const mechanism = make();
    const lockPath = path.join(withTempDir(context), 'a.lock');
    const first = await claimed(mechanism, lockPath);
    expect(await mechanism.isHeld(lockPath)).toBe(true);
    expect((await mechanism.claim(lockPath)).kind).toBe('held');
    first.release();
    expect(await mechanism.isHeld(lockPath)).toBe(false);
    (await claimed(mechanism, lockPath)).release();
  });

  it('reads back the holder it wrote', async (context) => {
    const mechanism = make();
    const lockPath = path.join(withTempDir(context), 'a.lock');
    const lock = await claimed(mechanism, lockPath);
    lock.writeHolder('holder 1');
    expect(await mechanism.readHolder(lockPath)).toBe('holder 1');
    lock.dispose();
  });

  it('refuses a claim through a symbolic link, for the file lock', async (context) => {
    const mechanism = make();
    if (mechanism.name !== 'file-lock') return;
    const root = withTempDir(context);
    fs.writeFileSync(path.join(root, 'real'), '');
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'a.lock'));
    await expect(mechanism.claim(path.join(root, 'a.lock'))).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it('refuses a hand-over whose holder does not carry the nonce, or whose descriptor is another file', async (context) => {
    const mechanism = make();
    const { claimInheritable, adoptInherited } = mechanism;
    if (claimInheritable === undefined || adoptInherited === undefined) return;
    const root = withTempDir(context);
    const lockPath = path.join(root, 'a.lock');
    const other = path.join(root, 'b.lock');
    const outcome = claimInheritable(lockPath);
    const otherOutcome = claimInheritable(other);
    if (outcome.kind !== 'claimed' || otherOutcome.kind !== 'claimed') throw new Error('the locks were not claimed');
    outcome.lock.writeHolder('nonce-a');
    otherOutcome.lock.writeHolder('nonce-a');
    const descriptor = outcome.lock.descriptor;
    const otherDescriptor = otherOutcome.lock.descriptor;
    if (descriptor === undefined || otherDescriptor === undefined) throw new Error('an inheritable lock has a descriptor');
    expect(() => adoptInherited({ lockPath, descriptor, expectedHolder: 'nonce-b', newHolder: 'child' })).toThrow(LockAdoptionError);
    expect(() => adoptInherited({ lockPath, descriptor: otherDescriptor, expectedHolder: 'nonce-a', newHolder: 'child' })).toThrow(LockAdoptionError);
    const adopted = adoptInherited({ lockPath, descriptor, expectedHolder: 'nonce-a', newHolder: 'child' });
    expect(await mechanism.readHolder(lockPath)).toBe('child');
    adopted.release();
    otherOutcome.lock.release();
  });
};
