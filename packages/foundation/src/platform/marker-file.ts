import path from 'node:path';
import { OPEN_FLAGS, nodeFileSystemSync } from '../node-file-system.ts';
import type { MarkerMode } from '../marker-state.ts';
import { EMPTY_RECORD_TEXT } from './marker-record.ts';
import { O_EXLOCK, O_SHLOCK } from './lock-capability.ts';
import type { LockCapabilityProbe } from './lock-capability.ts';
import { nodeFileLockOps } from './kernel-lock.ts';
import type { FileLockOps } from './kernel-lock.ts';

export interface MarkerHandle {
  readonly fd: number;
  readonly mode: MarkerMode;
  close(): void;
}

export type CreateMarkerOptions = { capability: LockCapabilityProbe; ops?: FileLockOps };

const MARKER_MODE = 0o600;

const createLockedFlags = (): number => OPEN_FLAGS.readWrite | OPEN_FLAGS.create | OPEN_FLAGS.exclusive | O_EXLOCK | OPEN_FLAGS.nonBlocking;
const createPlainFlags = (): number => OPEN_FLAGS.readWrite | OPEN_FLAGS.create | OPEN_FLAGS.exclusive;
const selfCheckFlags = (): number => OPEN_FLAGS.readOnly | O_SHLOCK | OPEN_FLAGS.nonBlocking;

const selfCheckHolds = (ops: FileLockOps, marker: string): boolean => {
  let descriptor: number;
  try {
    descriptor = ops.open(marker, selfCheckFlags());
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

export const closeMarkerDescriptor = (fd: number): void => {
  const handle = owned.get(fd);
  if (handle === undefined) nodeFileSystemSync.closeSync(fd);
  else handle.close();
};

const openWithRecord = (ops: FileLockOps, marker: string, flags: number): number => {
  const fd = ops.open(marker, flags, MARKER_MODE);
  try {
    nodeFileSystemSync.writeTextSync(fd, EMPTY_RECORD_TEXT);
  } catch (error) {
    ops.close(fd);
    nodeFileSystemSync.rmSync(marker);
    throw error;
  }
  return fd;
};

export const createMarker = async (marker: string, { capability, ops = nodeFileLockOps }: CreateMarkerOptions): Promise<MarkerHandle> => {
  const dir = path.dirname(marker);
  if ((await capability.of(dir)) !== 'proved') return handleOf(ops, openWithRecord(ops, marker, createPlainFlags()), 'listed');
  const fd = openWithRecord(ops, marker, createLockedFlags());
  if (selfCheckHolds(ops, marker)) return handleOf(ops, fd, 'locked');
  capability.contradicted(dir);
  return handleOf(ops, fd, 'listed');
};
