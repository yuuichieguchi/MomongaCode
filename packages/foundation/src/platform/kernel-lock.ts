import { OPEN_FLAGS, nodeFileSystemSync } from '../node-file-system.ts';
import { HOLDER_READ_MAX_BYTES, readHolderFile, readHolderFileSync, readHolderFromDescriptor, removeFilesThenRelease, rewriteHolderThroughDescriptor } from './holder-file.ts';
import { fstatIdentity, lstatIdentity, sameFile } from './file-identity.ts';
import type { LockFileIdentity } from './file-identity.ts';
import type { LockCapabilityProbe } from './lock-capability.ts';
import { sqliteFileLock } from './sqlite-lock.ts';
import { HOST_PLATFORM, openLockFlagsOn } from './open-lock-flags.ts';
import type { OpenLockFlags } from './open-lock-flags.ts';

export { HOLDER_READ_MAX_BYTES };

export class LockAdoptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockAdoptionError';
  }
}

export class FileLockUnavailableError extends Error {
  readonly platform: string;
  constructor(platform: string) {
    super(`the file lock needs the open flags O_SHLOCK and O_EXLOCK, which ${platform} does not define: the file-lock mechanism is not built there`);
    this.name = 'FileLockUnavailableError';
    this.platform = platform;
  }
}

export type HeldKernelLock = {
  readonly descriptor: number | undefined;
  writeHolder(text: string): void;
  release(): void;
  dispose(): void;
  readonly stillNamed?: () => boolean;
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

const WOULD_BLOCK = 'EAGAIN';
const LOCK_FILE_MODE = 0o600;

export type FileLockOps = {
  open(lockPath: string, flags: number, mode?: number): number;
  close(descriptor: number): void;
  fstat(descriptor: number): LockFileIdentity;
  lstat(lockPath: string): LockFileIdentity | undefined;
};

export const nodeFileLockOps: FileLockOps = {
  open: (lockPath, flags, mode) => nodeFileSystemSync.openDescriptorSync(lockPath, flags, mode),
  close: (descriptor) => nodeFileSystemSync.closeSync(descriptor),
  fstat: fstatIdentity,
  lstat: lstatIdentity,
};

const sharedProbeFlags = (flags: OpenLockFlags): number => OPEN_FLAGS.readOnly | flags.shared | OPEN_FLAGS.nonBlocking | OPEN_FLAGS.noFollow;

const exclusiveClaimFlags = (flags: OpenLockFlags): number => OPEN_FLAGS.readWrite | OPEN_FLAGS.create | flags.exclusive | OPEN_FLAGS.nonBlocking | OPEN_FLAGS.noFollow;

const holdsExclusively = (ops: FileLockOps, lockPath: string, flags: OpenLockFlags): boolean => {
  let descriptor: number;
  try {
    descriptor = ops.open(lockPath, sharedProbeFlags(flags));
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
    stillNamed: () => sameFile(ops.fstat(descriptor), ops.lstat(lockPath)),
  };
};

const probeFile = (ops: FileLockOps, lockPath: string, flags: OpenLockFlags): boolean => {
  try {
    return holdsExclusively(ops, lockPath, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

const claimFile =
  (ops: FileLockOps, flags: OpenLockFlags) =>
  (lockPath: string): ClaimOutcome => {
    for (;;) {
      let descriptor: number;
      try {
        descriptor = ops.open(lockPath, exclusiveClaimFlags(flags), LOCK_FILE_MODE);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== WOULD_BLOCK) throw error;
        if (probeFile(ops, lockPath, flags)) return { kind: 'held' };
        continue;
      }
      if (sameFile(ops.fstat(descriptor), ops.lstat(lockPath))) return { kind: 'claimed', lock: heldFile(ops, lockPath, descriptor) };
      ops.close(descriptor);
    }
  };

const adoptFile =
  (ops: FileLockOps) =>
  ({ lockPath, descriptor, expectedHolder, newHolder }: InheritedLockRequest): HeldKernelLock => {
    let inherited: LockFileIdentity;
    let inheritedIsFile: boolean;
    try {
      inherited = ops.fstat(descriptor);
      inheritedIsFile = nodeFileSystemSync.fstatSync(descriptor).isFile();
    } catch (error) {
      throw new LockAdoptionError(`descriptor ${descriptor} is not open: ${(error as Error).message}`);
    }
    if (!inheritedIsFile || !sameFile(inherited, nodeFileSystemSync.identitySync(lockPath))) {
      throw new LockAdoptionError(`descriptor ${descriptor} is not ${lockPath}`);
    }
    if (readHolderFromDescriptor(descriptor) !== expectedHolder) {
      throw new LockAdoptionError(`${lockPath} does not carry the hand-off nonce of this hand-off`);
    }
    const lock = heldFile(ops, lockPath, descriptor);
    lock.writeHolder(newHolder);
    return lock;
  };

export const createFileLock = (ops: FileLockOps, platform: string = HOST_PLATFORM): KernelLockMechanism => {
  const flags = openLockFlagsOn(platform);
  if (flags === undefined) throw new FileLockUnavailableError(platform);
  return {
    name: 'file-lock',
    claim: async (lockPath) => claimFile(ops, flags)(lockPath),
    claimSync: claimFile(ops, flags),
    isHeld: async (lockPath) => probeFile(ops, lockPath, flags),
    readHolder: readHolderFile,
    readHolderSync: readHolderFileSync,
    claimInheritable: claimFile(ops, flags),
    adoptInherited: adoptFile(ops),
  };
};

export const kernelLockNamed = (name: KernelLockMechanism['name'], platform: string = HOST_PLATFORM): KernelLockMechanism =>
  name === 'file-lock' ? createFileLock(nodeFileLockOps, platform) : sqliteFileLock;

export const resolveKernelLock = (dir: string, { capability, platform = HOST_PLATFORM }: { capability: LockCapabilityProbe; platform?: string }): KernelLockMechanism =>
  kernelLockNamed(capability.decide(dir) === 'proved' ? 'file-lock' : 'sqlite-lock', platform);
