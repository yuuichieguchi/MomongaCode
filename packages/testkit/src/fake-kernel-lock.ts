import fs from 'node:fs';
import path from 'node:path';
import { removeFilesThenRelease } from '@momonga/foundation';
import type { ClaimOutcome, HeldKernelLock, KernelLockMechanism } from '@momonga/foundation';

export type FakeKernelLock = KernelLockMechanism & {
  holdExternally(lockPath: string, pid: number): void;
  releaseExternally(lockPath: string): void;
  isHeldBy(lockPath: string): 'external' | 'claim' | undefined;
  claimsMade(): readonly string[];
  adoptionsMade(): readonly { lockPath: string; descriptor: number }[];
};

export type FakeKernelLockOptions = { inheritable: boolean };

const FIRST_DESCRIPTOR = 900;

export const createFakeKernelLock = ({ inheritable }: FakeKernelLockOptions): FakeKernelLock => {
  const holders = new Map<string, 'external' | 'claim'>();
  const claims: string[] = [];
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
      dispose: () => removeFilesThenRelease([lockPath], release),
    };
  };
  const claimSync = (lockPath: string): ClaimOutcome => {
    if (holders.has(lockPath)) return { kind: 'held' };
    holders.set(lockPath, 'claim');
    claims.push(lockPath);
    return { kind: 'claimed', lock: claimedLock(lockPath, inheritable ? nextDescriptor++ : undefined) };
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
    name: 'file-lock',
    claim: async (lockPath) => claimSync(lockPath),
    isHeld: async (lockPath) => holders.has(lockPath),
    readHolder: async (lockPath) => readHolderSync(lockPath),
    readHolderSync,
    claimInheritable: inheritable ? claimSync : undefined,
    adoptInherited: inheritable
      ? (request) => {
          adoptions.push({ lockPath: request.lockPath, descriptor: request.descriptor });
          holders.set(request.lockPath, 'claim');
          const lock = claimedLock(request.lockPath, request.descriptor);
          lock.writeHolder(request.newHolder);
          return lock;
        }
      : undefined,
    holdExternally: (lockPath, pid) => {
      holders.set(lockPath, 'external');
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
