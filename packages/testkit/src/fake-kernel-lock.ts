import fs from 'node:fs';
import path from 'node:path';
import { LOCK_DATABASE_SUFFIX, LockAdoptionError, OPEN_FLAGS, nodeFileSystemSync, removeFilesThenRelease } from '@momonga/foundation';
import type { ClaimOutcome, HeldKernelLock, KernelLockMechanism } from '@momonga/foundation';

export type FakeKernelLock = KernelLockMechanism & {
  holdExternally(lockPath: string, pid: number | undefined): void;
  releaseExternally(lockPath: string): void;
  isHeldBy(lockPath: string): 'external' | 'claim' | undefined;
  claimsMade(): readonly string[];
  adoptionsMade(): readonly { lockPath: string; descriptor: number }[];
};

export type FakeKernelLockOptions = { inheritable: boolean; disk?: 'in-memory' };

const FIRST_DESCRIPTOR = 900;

export const createFakeKernelLock = ({ inheritable, disk }: FakeKernelLockOptions): FakeKernelLock => {
  const holders = new Map<string, 'external' | 'claim'>();
  const claims: string[] = [];
  const pathOfDescriptor = new Map<number, string>();
  let nextDescriptor = FIRST_DESCRIPTOR;
  const adoptions: { lockPath: string; descriptor: number }[] = [];
  const claimedLock = (lockPath: string, descriptor: number | undefined): HeldKernelLock => {
    let open = true;
    const release = (): void => {
      if (!open) return;
      open = false;
      holders.delete(lockPath);
    };
    return {
      descriptor,
      writeHolder: (text) => fs.writeFileSync(lockPath, text, { mode: 0o600 }),
      release,
      dispose: () => removeFilesThenRelease([...new Set([lockPath, claimedFileOf(lockPath)])], release),
    };
  };
  const claimedFileOf = (lockPath: string): string => (inheritable ? lockPath : `${lockPath}${LOCK_DATABASE_SUFFIX}`);
  const touch = (lockPath: string): void => {
    if (disk === 'in-memory') return;
    nodeFileSystemSync.closeSync(nodeFileSystemSync.openDescriptorSync(claimedFileOf(lockPath), OPEN_FLAGS.readWrite | OPEN_FLAGS.create | OPEN_FLAGS.noFollow, 0o600));
  };
  const claimSync = (lockPath: string): ClaimOutcome => {
    if (holders.has(lockPath)) return { kind: 'held' };
    touch(lockPath);
    holders.set(lockPath, 'claim');
    claims.push(lockPath);
    if (!inheritable) return { kind: 'claimed', lock: claimedLock(lockPath, undefined) };
    const descriptor = nextDescriptor++;
    pathOfDescriptor.set(descriptor, lockPath);
    return { kind: 'claimed', lock: claimedLock(lockPath, descriptor) };
  };
  const readHolderSync = (lockPath: string): string | undefined => {
    try {
      return fs.readFileSync(lockPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  return {
    name: inheritable ? 'file-lock' : 'sqlite-lock',
    claim: async (lockPath) => claimSync(lockPath),
    isHeld: async (lockPath) => holders.has(lockPath),
    readHolder: async (lockPath) => readHolderSync(lockPath),
    readHolderSync,
    claimInheritable: inheritable ? claimSync : undefined,
    adoptInherited: inheritable
      ? (request) => {
          if (pathOfDescriptor.get(request.descriptor) !== request.lockPath) throw new LockAdoptionError(`descriptor ${request.descriptor} is not ${request.lockPath}`);
          if (readHolderSync(request.lockPath) !== request.expectedHolder) throw new LockAdoptionError(`${request.lockPath} does not carry the hand-off nonce of this hand-off`);
          adoptions.push({ lockPath: request.lockPath, descriptor: request.descriptor });
          holders.set(request.lockPath, 'claim');
          const lock = claimedLock(request.lockPath, request.descriptor);
          lock.writeHolder(request.newHolder);
          return lock;
        }
      : undefined,
    holdExternally: (lockPath, pid) => {
      holders.set(lockPath, 'external');
      if (pid === undefined) return;
      fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(lockPath, String(pid), { mode: 0o600 });
    },
    releaseExternally: (lockPath) => {
      if (holders.get(lockPath) === 'external') holders.delete(lockPath);
    },
    isHeldBy: (lockPath) => holders.get(lockPath),
    claimsMade: () => [...claims],
    adoptionsMade: () => [...adoptions],
  };
};
