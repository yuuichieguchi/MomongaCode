import fs from 'node:fs';
import { HOLDER_READ_MAX_BYTES, readHolderFile, readHolderFileSync, readHolderFromDescriptor, removeFilesThenRelease, rewriteHolderThroughDescriptor } from './holder-file.ts';
import { fstatIdentity, lstatIdentity, sameFile } from './file-identity.ts';
import type { LockFileIdentity } from './file-identity.ts';
import type { LockCapabilityProbe } from './lock-capability.ts';
import { sqliteFileLock } from './sqlite-lock.ts';

export { HOLDER_READ_MAX_BYTES };

export class LockAdoptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockAdoptionError';
  }
}

export type HeldKernelLock = {
  readonly descriptor: number | undefined;
  writeHolder(text: string): void;
  release(): void;
  dispose(): void;
};

export const writeHolderOrRelease = (lock: HeldKernelLock, text: string): void => {
  try {
    lock.writeHolder(text);
  } catch (error) {
    lock.release();
    throw error;
  }
};

export type ClaimOutcome = { kind: 'claimed'; lock: HeldKernelLock } | { kind: 'held' };

export type InheritedLockRequest = { lockPath: string; descriptor: number; expectedHolder: string; newHolder: string };

export interface KernelLockMechanism {
  readonly name: 'file-lock' | 'sqlite-lock';
  claim(lockPath: string): Promise<ClaimOutcome>;
  readonly claimSync?: (lockPath: string) => ClaimOutcome;
  isHeld(lockPath: string): Promise<boolean>;
  readHolder(lockPath: string): Promise<string | undefined>;
  readHolderSync(lockPath: string): string | undefined;
  readonly claimInheritable: ((lockPath: string) => ClaimOutcome) | undefined;
  readonly adoptInherited: ((request: InheritedLockRequest) => HeldKernelLock) | undefined;
}

const O_SHLOCK = 0x10;
const O_EXLOCK = 0x20;

const WOULD_BLOCK = 'EAGAIN';

export type FileLockOps = {
  open(lockPath: string, flags: number, mode?: number): number;
  close(descriptor: number): void;
  fstat(descriptor: number): LockFileIdentity;
  lstat(lockPath: string): LockFileIdentity | undefined;
};

export const nodeFileLockOps: FileLockOps = {
  open: (lockPath, flags, mode) => fs.openSync(lockPath, flags, mode),
  close: (descriptor) => fs.closeSync(descriptor),
  fstat: fstatIdentity,
  lstat: lstatIdentity,
};

const SHARED_PROBE_FLAGS = fs.constants.O_RDONLY | O_SHLOCK | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;

const holdsExclusively = (ops: FileLockOps, lockPath: string): boolean => {
  let descriptor: number;
  try {
    descriptor = ops.open(lockPath, SHARED_PROBE_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === WOULD_BLOCK) return true;
    throw error;
  }
  ops.close(descriptor);
  return false;
};

const heldFile = (ops: FileLockOps, lockPath: string, descriptor: number): HeldKernelLock => {
  let open = true;
  const release = (): void => {
    if (!open) return;
    open = false;
    ops.close(descriptor);
  };
  return {
    descriptor,
    writeHolder: (text) => rewriteHolderThroughDescriptor(descriptor, text),
    release,
    dispose: () => removeFilesThenRelease([lockPath], release),
  };
};

const probeFile = (ops: FileLockOps, lockPath: string): boolean => {
  try {
    return holdsExclusively(ops, lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const claimFile =
  (ops: FileLockOps) =>
  (lockPath: string): ClaimOutcome => {
    const { O_RDWR, O_CREAT, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
    for (;;) {
      let descriptor: number;
      try {
        descriptor = ops.open(lockPath, O_RDWR | O_CREAT | O_EXLOCK | O_NONBLOCK | O_NOFOLLOW, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== WOULD_BLOCK) throw error;
        if (probeFile(ops, lockPath)) return { kind: 'held' };
        continue;
      }
      if (sameFile(ops.fstat(descriptor), ops.lstat(lockPath))) return { kind: 'claimed', lock: heldFile(ops, lockPath, descriptor) };
      ops.close(descriptor);
    }
  };

const adoptFile =
  (ops: FileLockOps) =>
  ({ lockPath, descriptor, expectedHolder, newHolder }: InheritedLockRequest): HeldKernelLock => {
    let inherited: fs.BigIntStats;
    try {
      inherited = fs.fstatSync(descriptor, { bigint: true });
    } catch (error) {
      throw new LockAdoptionError(`descriptor ${descriptor} is not open: ${(error as Error).message}`);
    }
    const named = fs.statSync(lockPath, { bigint: true });
    if (!inherited.isFile() || inherited.dev !== named.dev || inherited.ino !== named.ino) {
      throw new LockAdoptionError(`descriptor ${descriptor} is not ${lockPath}`);
    }
    if (readHolderFromDescriptor(descriptor) !== expectedHolder) {
      throw new LockAdoptionError(`${lockPath} does not carry the hand-off nonce of this hand-off`);
    }
    const lock = heldFile(ops, lockPath, descriptor);
    lock.writeHolder(newHolder);
    return lock;
  };

export const createFileLock = (ops: FileLockOps): KernelLockMechanism => ({
  name: 'file-lock',
  claim: async (lockPath) => claimFile(ops)(lockPath),
  claimSync: claimFile(ops),
  isHeld: async (lockPath) => probeFile(ops, lockPath),
  readHolder: readHolderFile,
  readHolderSync: readHolderFileSync,
  claimInheritable: claimFile(ops),
  adoptInherited: adoptFile(ops),
});

export const bsdFileLock: KernelLockMechanism = createFileLock(nodeFileLockOps);

export const resolveKernelLock = async (dir: string, { capability }: { capability: LockCapabilityProbe }): Promise<KernelLockMechanism> =>
  (await capability.of(dir)) === 'proved' ? bsdFileLock : sqliteFileLock;
