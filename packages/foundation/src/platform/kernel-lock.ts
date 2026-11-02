import fs from 'node:fs';
import { HOLDER_READ_MAX_BYTES, readHolderFile, readHolderFileSync, readHolderFromDescriptor, rewriteHolderThroughDescriptor } from './holder-file.ts';
import { UnsupportedPlatformError } from './process-inspector.ts';
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
};

export type ClaimOutcome = { kind: 'claimed'; lock: HeldKernelLock } | { kind: 'held' };

export type InheritedLockRequest = { lockPath: string; descriptor: number; expectedHolder: string; newHolder: string };

export interface KernelLockMechanism {
  readonly name: 'file-lock' | 'sqlite-lock';
  claim(lockPath: string): Promise<ClaimOutcome>;
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
};

export const nodeFileLockOps: FileLockOps = {
  open: (lockPath, flags, mode) => fs.openSync(lockPath, flags, mode),
  close: (descriptor) => fs.closeSync(descriptor),
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

const heldFile = (ops: FileLockOps, descriptor: number): HeldKernelLock => {
  let open = true;
  return {
    descriptor,
    writeHolder: (text) => rewriteHolderThroughDescriptor(descriptor, text),
    release: () => {
      if (!open) return;
      open = false;
      ops.close(descriptor);
    },
  };
};

const claimFile =
  (ops: FileLockOps) =>
  (lockPath: string): ClaimOutcome => {
    const { O_RDWR, O_CREAT, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
    for (;;) {
      try {
        return { kind: 'claimed', lock: heldFile(ops, ops.open(lockPath, O_RDWR | O_CREAT | O_EXLOCK | O_NONBLOCK | O_NOFOLLOW, 0o600)) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== WOULD_BLOCK) throw error;
        if (holdsExclusively(ops, lockPath)) return { kind: 'held' };
      }
    }
  };

const probeFile = (ops: FileLockOps, lockPath: string): boolean => {
  try {
    return holdsExclusively(ops, lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
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
    const lock = heldFile(ops, descriptor);
    lock.writeHolder(newHolder);
    return lock;
  };

export const createFileLock = (ops: FileLockOps): KernelLockMechanism => ({
  name: 'file-lock',
  claim: async (lockPath) => claimFile(ops)(lockPath),
  isHeld: async (lockPath) => probeFile(ops, lockPath),
  readHolder: readHolderFile,
  readHolderSync: readHolderFileSync,
  claimInheritable: claimFile(ops),
  adoptInherited: adoptFile(ops),
});

export const darwinFileLock: KernelLockMechanism = createFileLock(nodeFileLockOps);

export const createKernelLockMechanism = (platform: NodeJS.Platform): KernelLockMechanism => {
  switch (platform) {
    case 'darwin':
      return darwinFileLock;
    case 'linux':
    case 'win32':
      return sqliteFileLock;
    default:
      throw new UnsupportedPlatformError(platform, 'process locks');
  }
};

export const hostKernelLock = (): KernelLockMechanism => createKernelLockMechanism(process.platform);
