import fs from 'node:fs';
import path from 'node:path';
import type { MarkerMode } from '../marker-state.ts';
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

const createLockedFlags = (): number => fs.constants.O_RDONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_EXLOCK | fs.constants.O_NONBLOCK;
const createPlainFlags = (): number => fs.constants.O_RDONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
const selfCheckFlags = (): number => fs.constants.O_RDONLY | O_SHLOCK | fs.constants.O_NONBLOCK;

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
  if (handle === undefined) fs.closeSync(fd);
  else handle.close();
};

export const createMarker = async (marker: string, { capability, ops = nodeFileLockOps }: CreateMarkerOptions): Promise<MarkerHandle> => {
  const dir = path.dirname(marker);
  if ((await capability.of(dir)) !== 'proved') return handleOf(ops, ops.open(marker, createPlainFlags(), MARKER_MODE), 'listed');
  const fd = ops.open(marker, createLockedFlags(), MARKER_MODE);
  if (selfCheckHolds(ops, marker)) return handleOf(ops, fd, 'locked');
  capability.contradicted(dir);
  return handleOf(ops, fd, 'listed');
};
