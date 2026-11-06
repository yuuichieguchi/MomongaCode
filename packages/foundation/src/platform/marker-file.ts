import path from 'node:path';
import { OPEN_FLAGS, nodeFileSystemSync } from '../node-file-system.ts';
import type { MarkerMode } from '../marker-state.ts';
import { EMPTY_RECORD_TEXT } from './marker-record.ts';
import { O_SHLOCK, createLockedFile } from './lock-capability.ts';
import type { LockCapabilityProbe, StagingFiles } from './lock-capability.ts';
import { nodeFileLockOps } from './kernel-lock.ts';
import type { FileLockOps } from './kernel-lock.ts';

export interface MarkerHandle {
  readonly fd: number;
  readonly mode: MarkerMode;
  close(): void;
}

export type CreateMarkerOptions = { capability: LockCapabilityProbe; ops?: FileLockOps; files?: StagingFiles };

const MARKER_MODE = 0o600;

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

const writeEmptyRecord = (fd: number): void => nodeFileSystemSync.writeTextSync(fd, EMPTY_RECORD_TEXT);

const openPlainWithRecord = (ops: FileLockOps, marker: string): number => {
  const fd = ops.open(marker, createPlainFlags(), MARKER_MODE);
  try {
    writeEmptyRecord(fd);
  } catch (error) {
    ops.close(fd);
    nodeFileSystemSync.rmSync(marker);
    throw error;
  }
  return fd;
};

export const createMarker = async (marker: string, { capability, ops = nodeFileLockOps, files = nodeFileSystemSync }: CreateMarkerOptions): Promise<MarkerHandle> => {
  const dir = path.dirname(marker);
  if ((await capability.of(dir)) !== 'proved') return handleOf(ops, openPlainWithRecord(ops, marker), 'listed');
  const fd = createLockedFile(ops, marker, OPEN_FLAGS.readWrite, MARKER_MODE, writeEmptyRecord, files);
  if (selfCheckHolds(ops, marker)) return handleOf(ops, fd, 'locked');
  capability.contradicted(dir);
  return handleOf(ops, fd, 'listed');
};
