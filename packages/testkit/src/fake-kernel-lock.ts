import fs from 'node:fs';
import path from 'node:path';
import type { ClaimOutcome, KernelLockMechanism } from '@momonga/foundation';

export type FakeKernelLock = KernelLockMechanism & {
  holdExternally(lockPath: string, pid: number): void;
  releaseExternally(lockPath: string): void;
  isHeldBy(lockPath: string): 'external' | 'claim' | undefined;
  claimsMade(): readonly string[];
};

export type FakeKernelLockOptions = { inheritable: boolean };

const FIRST_DESCRIPTOR = 900;

export const createFakeKernelLock = ({ inheritable }: FakeKernelLockOptions): FakeKernelLock => {
  const holders = new Map<string, 'external' | 'claim'>();
  const claims: string[] = [];
  let nextDescriptor = FIRST_DESCRIPTOR;
  const claimSync = (lockPath: string): ClaimOutcome => {
    if (holders.has(lockPath)) return { kind: 'held' };
    holders.set(lockPath, 'claim');
    claims.push(lockPath);
    const descriptor = inheritable ? nextDescriptor++ : undefined;
    let open = true;
    return {
      kind: 'claimed',
      lock: {
        descriptor,
        writeHolder: (text) => fs.writeFileSync(lockPath, text, { mode: 0o600 }),
        release: () => {
          if (!open) return;
          open = false;
          holders.delete(lockPath);
        },
      },
    };
  };
  return {
    name: 'file-lock',
    claim: async (lockPath) => claimSync(lockPath),
    isHeld: async (lockPath) => holders.has(lockPath),
    claimInheritable: inheritable ? claimSync : undefined,
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
  };
};
