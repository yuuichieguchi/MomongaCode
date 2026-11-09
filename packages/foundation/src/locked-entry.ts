import { ClaimedEntryReplacedError, openClaimedEntry } from './atomic-file.ts';
import type { AtomicWriteFileHandle, AtomicWriteFileSystem } from './atomic-file.ts';
import type { HeldKernelLock, KernelLockMechanism } from './platform/kernel-lock.ts';
import { claimNewEntry, lockFormOf } from './platform/lock-form.ts';
import type { LockForm } from './platform/lock-form.ts';

export type LockedEntry = {
  readonly path: string;
  readonly form: LockForm;
  readonly handle: AtomicWriteFileHandle;
  finish(): void;
  remove(): Promise<void>;
  assertStillNamed(): void;
};

export type LockedEntryFiles = Pick<AtomicWriteFileSystem, 'open' | 'rm' | 'descriptors'>;

const finisherOf = (form: LockForm, held: HeldKernelLock): (() => void) => {
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    if (form === 'sidecar') held.dispose();
    else held.release();
  };
};

export const createLockedEntry = async (files: LockedEntryFiles, lock: KernelLockMechanism, entry: string, mode: number): Promise<LockedEntry> => {
  const form = lockFormOf(lock, 'file');
  const held = await claimNewEntry(lock, entry, form);
  const finish = finisherOf(form, held);
  let handle: AtomicWriteFileHandle;
  try {
    handle = await openClaimedEntry(files, held, entry, mode);
  } catch (error) {
    if (form === 'entry') await files.rm(entry);
    finish();
    throw error;
  }
  return {
    path: entry,
    form,
    handle,
    finish,
    assertStillNamed: () => {
      if (held.stillNamed?.() !== false) return;
      finish();
      throw new ClaimedEntryReplacedError(entry);
    },
    remove: async () => {
      try {
        await files.rm(entry);
      } catch (error) {
        held.release();
        throw error;
      }
      finish();
    },
  };
};
