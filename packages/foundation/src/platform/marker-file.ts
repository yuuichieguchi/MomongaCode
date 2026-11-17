import path from 'node:path';
import { OPEN_FLAGS, nodeFileSystemSync } from '../node-file-system.ts';
import type { MarkerMode } from '../marker-state.ts';
import { EMPTY_RECORD_TEXT } from './marker-record.ts';
import { createLockedFile } from './lock-capability.ts';
import type { LockCapabilityProbe, StagingFiles } from './lock-capability.ts';
import { FileLockUnavailableError, nodeFileLockOps } from './kernel-lock.ts';
import type { FileLockOps } from './kernel-lock.ts';
import { HOST_PLATFORM, openLockFlagsOn } from './open-lock-flags.ts';

export interface MarkerHandle {
  readonly fd: number;
  readonly mode: MarkerMode;
  close(): void;
}

export type CreateMarkerOptions = { capability: LockCapabilityProbe; ops?: FileLockOps; files?: StagingFiles; platform?: string };

const MARKER_MODE = 0o600;

const createPlainFlags = (): number => OPEN_FLAGS.readWrite | OPEN_FLAGS.create | OPEN_FLAGS.exclusive;
const selfCheckFlags = (platform: string): number => {
  const flags = openLockFlagsOn(platform);
  if (flags === undefined) throw new FileLockUnavailableError(platform);
  return OPEN_FLAGS.readOnly | flags.shared | OPEN_FLAGS.nonBlocking;
};

const selfCheckHolds = (ops: FileLockOps, marker: string, platform: string): boolean => {
  const flags = selfCheckFlags(platform);
  let descriptor: number;
  try {
    descriptor = ops.open(marker, flags);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EAGAIN';
  }
  ops.close(descriptor);
  return false;
};

const owned = new Map<number, MarkerHandle>();

const handleOf = (ops: FileLockOps, fd: number, mode: MarkerMode): MarkerHandle => {
  let open = true;
  const handle: MarkerHandle = {
    fd,
    mode,
    close: () => {
      if (!open) return;
      open = false;
      owned.delete(fd);
      ops.close(fd);
    },
  };
  owned.set(fd, handle);
  return handle;
};

export class UnregisteredDescriptorError extends Error {
  readonly fd: number;

  constructor(fd: number) {
    super(`the descriptor ${fd} is not a marker this process opened; it is left open`);
    this.name = 'UnregisteredDescriptorError';
    this.fd = fd;
  }
}

export const closeMarkerDescriptor = (fd: number): void => {
  const handle = owned.get(fd);
  if (handle === undefined) throw new UnregisteredDescriptorError(fd);
  handle.close();
};

const writeEmptyRecord = (file: string): void => {
  const writer = nodeFileSystemSync.openDescriptorSync(file, OPEN_FLAGS.readWrite);
  try {
    nodeFileSystemSync.writeTextSync(writer, EMPTY_RECORD_TEXT);
  } finally {
    nodeFileSystemSync.closeSync(writer);
  }
};

const openPlainWithRecord = (ops: FileLockOps, marker: string): number => {
  const creator = ops.open(marker, createPlainFlags(), MARKER_MODE);
  try {
    nodeFileSystemSync.writeTextSync(creator, EMPTY_RECORD_TEXT);
    return ops.open(marker, OPEN_FLAGS.readOnly);
  } catch (error) {
    nodeFileSystemSync.rmSync(marker);
    throw error;
  } finally {
    ops.close(creator);
  }
};

export const createMarker = async (marker: string, { capability, ops = nodeFileLockOps, files = nodeFileSystemSync, platform = HOST_PLATFORM }: CreateMarkerOptions): Promise<MarkerHandle> => {
  const dir = path.dirname(marker);
  if ((await capability.of(dir)) !== 'proved') return handleOf(ops, openPlainWithRecord(ops, marker), 'listed');
  const fd = createLockedFile(ops, platform, marker, OPEN_FLAGS.readOnly, MARKER_MODE, writeEmptyRecord, files);
  if (selfCheckHolds(ops, marker, platform)) return handleOf(ops, fd, 'locked');
  capability.contradicted(dir);
  return handleOf(ops, fd, 'listed');
};
