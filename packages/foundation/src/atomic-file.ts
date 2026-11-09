import path from 'node:path';
import type { HeldKernelLock, KernelLockMechanism } from './platform/kernel-lock.ts';
import { hostKernelLock } from './platform/host-kernel-lock.ts';
import { claimNewEntry, claimNewEntrySync, lockFormOf } from './platform/lock-form.ts';
import type { LockForm } from './platform/lock-form.ts';
import type { Random } from './random.ts';

export type FileContent = string | Uint8Array;

export interface AtomicWriteFileHandle {
  writeFile(content: FileContent): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface DescriptorWriter {
  write(descriptor: number, content: FileContent): Promise<void>;
  sync(descriptor: number): Promise<void>;
  chmod(descriptor: number, mode: number): Promise<void>;
}

export interface DescriptorWriterSync {
  write(descriptor: number, content: FileContent): void;
  sync(descriptor: number): void;
  chmod(descriptor: number, mode: number): void;
}

export interface AtomicWriteFileSystem {
  open(file: string, flags: string, mode?: number): Promise<AtomicWriteFileHandle>;
  readonly descriptors?: DescriptorWriter;
  rename(from: string, to: string): Promise<void>;
  link(from: string, to: string): Promise<void>;
  rm(file: string): Promise<void>;
}

export interface AtomicWriteFileSystemSync<Handle = string> {
  openSync(file: string, flags: string, mode?: number): Handle;
  readonly descriptorsSync?: DescriptorWriterSync;
  writeFileSync(handle: Handle, content: FileContent): void;
  fsyncSync(handle: Handle): void;
  closeSync(handle: Handle): void;
  renameSync(from: string, to: string): void;
  linkSync(from: string, to: string): void;
  rmSync(file: string): void;
}

export type PublishMode = 'replace' | 'create';

export const ATOMIC_WRITE_STEP_ACTIONS = {
  createLocked: 'CreateLocked',
  lockSidecar: 'CreateLocked',
  createTemporary: 'CreateLocked',
  write: 'CreateLocked',
  publish: 'Publish',
  unlinkStaged: 'Dispose',
  unlinkSidecar: 'Dispose',
  release: 'Dispose',
} as const;

export type AtomicWriteStep = keyof typeof ATOMIC_WRITE_STEP_ACTIONS;

const CREATION_STEPS: Readonly<Record<LockForm, readonly AtomicWriteStep[]>> = {
  entry: ['createLocked'],
  sidecar: ['lockSidecar', 'createTemporary'],
};

const DISPOSAL_STEPS: Readonly<Record<LockForm, readonly AtomicWriteStep[]>> = {
  entry: ['release'],
  sidecar: ['unlinkSidecar', 'release'],
};

const STAGED_UNLINK_STEPS: Readonly<Record<PublishMode, readonly AtomicWriteStep[]>> = {
  replace: [],
  create: ['unlinkStaged'],
};

export const atomicWriteSteps = (form: LockForm, publish: PublishMode): AtomicWriteStep[] => [
  ...CREATION_STEPS[form],
  'write',
  'publish',
  ...STAGED_UNLINK_STEPS[publish],
  ...DISPOSAL_STEPS[form],
];

type WriterLock = { lock?: KernelLockMechanism; onStep?(step: AtomicWriteStep): void };

export type AtomicWriteOptions = WriterLock & {
  mode: number;
  publish?: PublishMode;
  beforePublish?(): Promise<void>;
  afterPublish?(): Promise<void>;
};

export type AtomicWriteOptionsSync = WriterLock & {
  mode: number;
  publish?: PublishMode;
  beforePublish?(): void;
  afterPublish?(): void;
};

export type CreateOutcome = { created: boolean };

const TEMPORARY_SUFFIX_BYTES = 6;
const READ_ONLY = 'r';
const EXCLUSIVE_CREATE = 'wx';
const TEMPORARY_PATTERN = /^\..+\.[0-9a-f]+\.tmp$/;

export const isAtomicWriteTemporary = (name: string): boolean => TEMPORARY_PATTERN.test(name);

const temporaryOf = (random: Random, file: string): string =>
  path.join(path.dirname(file), `.${path.basename(file)}.${random.hex(TEMPORARY_SUFFIX_BYTES)}.tmp`);

const isAlreadyExists = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'EEXIST';

export const syncDirectory = async (fs: Pick<AtomicWriteFileSystem, 'open'>, directory: string): Promise<void> => {
  const handle = await fs.open(directory, READ_ONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const syncDirectorySync = <Handle>(fs: Pick<AtomicWriteFileSystemSync<Handle>, 'openSync' | 'fsyncSync' | 'closeSync'>, directory: string): void => {
  const handle = fs.openSync(directory, READ_ONLY);
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
};

type Write<Handle> = {
  readonly form: LockForm;
  readonly temporary: string;
  held: HeldKernelLock | undefined;
  handle: Handle | undefined;
  ownsTemporary: boolean;
  created: boolean;
};

const startWrite = <Handle>(mechanism: KernelLockMechanism, random: Random, file: string): Write<Handle> => ({
  form: lockFormOf(mechanism, 'file'),
  temporary: temporaryOf(random, file),
  held: undefined,
  handle: undefined,
  ownsTemporary: false,
  created: true,
});

export class ClaimedDescriptorUnwritableError extends Error {
  constructor(entry: string) {
    super(`${entry} is locked through a descriptor, and the filesystem given to the writer cannot write through a descriptor, so the entry is not reopened by its path`);
    this.name = 'ClaimedDescriptorUnwritableError';
  }
}

type SyncHandle = { write(content: FileContent): void; sync(): void; close(): void };

const descriptorHandle = (writer: DescriptorWriter, descriptor: number): AtomicWriteFileHandle => ({
  writeFile: (content) => writer.write(descriptor, content),
  sync: () => writer.sync(descriptor),
  close: async () => undefined,
});

const descriptorHandleSync = (writer: DescriptorWriterSync, descriptor: number): SyncHandle => ({
  write: (content) => writer.write(descriptor, content),
  sync: () => writer.sync(descriptor),
  close: () => undefined,
});

export const openClaimedEntry = async (fs: Pick<AtomicWriteFileSystem, 'open' | 'descriptors'>, held: HeldKernelLock, entry: string, mode: number): Promise<AtomicWriteFileHandle> => {
  if (held.descriptor === undefined) return fs.open(entry, EXCLUSIVE_CREATE, mode);
  if (fs.descriptors === undefined) throw new ClaimedDescriptorUnwritableError(entry);
  await fs.descriptors.chmod(held.descriptor, mode);
  return descriptorHandle(fs.descriptors, held.descriptor);
};

const openClaimedEntrySync = <Handle>(fs: AtomicWriteFileSystemSync<Handle>, held: HeldKernelLock, entry: string, mode: number): SyncHandle => {
  if (held.descriptor === undefined) return pathHandleSync(fs, fs.openSync(entry, EXCLUSIVE_CREATE, mode));
  if (fs.descriptorsSync === undefined) throw new ClaimedDescriptorUnwritableError(entry);
  fs.descriptorsSync.chmod(held.descriptor, mode);
  return descriptorHandleSync(fs.descriptorsSync, held.descriptor);
};

const pathHandleSync = <Handle>(fs: AtomicWriteFileSystemSync<Handle>, handle: Handle): SyncHandle => ({
  write: (content) => fs.writeFileSync(handle, content),
  sync: () => fs.fsyncSync(handle),
  close: () => fs.closeSync(handle),
});

export class ClaimedEntryReplacedError extends Error {
  constructor(entry: string) {
    super(`${entry} no longer names the file this writer locked, so it is not published`);
    this.name = 'ClaimedEntryReplacedError';
  }
}

const assertStillClaimed = <Handle>(write: Write<Handle>): void => {
  if (heldOf(write).stillNamed?.() !== false) return;
  write.ownsTemporary = false;
  throw new ClaimedEntryReplacedError(write.temporary);
};

const heldOf = <Handle>(write: Write<Handle>): HeldKernelLock => {
  if (write.held === undefined) throw new Error(`${write.temporary} has no lock at a step that needs it`);
  return write.held;
};

const handleOf = <Handle>(write: Write<Handle>): Handle => {
  if (write.handle === undefined) throw new Error(`${write.temporary} is not open at the write step`);
  return write.handle;
};

const releaseAfterFailure = <Handle>(write: Write<Handle>): void => {
  const held = write.held;
  write.held = undefined;
  if (held === undefined) return;
  if (write.form === 'sidecar') held.dispose();
  else held.release();
};

export function writeFileAtomically(
  fs: AtomicWriteFileSystem,
  random: Random,
  file: string,
  content: FileContent,
  options: AtomicWriteOptions & { publish: 'create' },
): Promise<CreateOutcome>;
export function writeFileAtomically(fs: AtomicWriteFileSystem, random: Random, file: string, content: FileContent, options: AtomicWriteOptions): Promise<CreateOutcome | undefined>;
export async function writeFileAtomically(
  fs: AtomicWriteFileSystem,
  random: Random,
  file: string,
  content: FileContent,
  options: AtomicWriteOptions,
): Promise<CreateOutcome | undefined> {
  const publish = options.publish ?? 'replace';
  const mechanism = options.lock ?? hostKernelLock();
  const write = startWrite<AtomicWriteFileHandle>(mechanism, random, file);
  const { temporary } = write;
  const perform: Record<AtomicWriteStep, () => Promise<void>> = {
    createLocked: async () => {
      write.held = await claimNewEntry(mechanism, temporary, 'entry');
      write.ownsTemporary = true;
      write.handle = await openClaimedEntry(fs, write.held, temporary, options.mode);
    },
    lockSidecar: async () => {
      write.held = await claimNewEntry(mechanism, temporary, 'sidecar');
    },
    createTemporary: async () => {
      write.handle = await fs.open(temporary, EXCLUSIVE_CREATE, options.mode);
      write.ownsTemporary = true;
    },
    write: async () => {
      const handle = handleOf(write);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        write.handle = undefined;
        await handle.close();
      }
    },
    publish: async () => {
      await options.beforePublish?.();
      assertStillClaimed(write);
      if (publish === 'replace') await fs.rename(temporary, file);
      else {
        try {
          await fs.link(temporary, file);
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
          write.created = false;
        }
      }
      if (write.created) await options.afterPublish?.();
    },
    unlinkStaged: () => fs.rm(temporary),
    unlinkSidecar: async () => {
      const held = heldOf(write);
      write.held = undefined;
      held.dispose();
    },
    release: async () => {
      const held = write.held;
      write.held = undefined;
      held?.release();
    },
  };
  try {
    for (const step of atomicWriteSteps(write.form, publish)) {
      options.onStep?.(step);
      await perform[step]();
    }
  } catch (error) {
    const handle = write.handle;
    write.handle = undefined;
    if (handle !== undefined) await handle.close();
    if (write.held !== undefined && write.ownsTemporary) await fs.rm(temporary);
    releaseAfterFailure(write);
    throw error;
  }
  await syncDirectory(fs, path.dirname(file));
  return publish === 'create' ? { created: write.created } : undefined;
}

export function writeFileAtomicallySync<Handle>(
  fs: AtomicWriteFileSystemSync<Handle>,
  random: Random,
  file: string,
  content: FileContent,
  options: AtomicWriteOptionsSync & { publish: 'create' },
): CreateOutcome;
export function writeFileAtomicallySync<Handle>(
  fs: AtomicWriteFileSystemSync<Handle>,
  random: Random,
  file: string,
  content: FileContent,
  options: AtomicWriteOptionsSync,
): CreateOutcome | undefined;
export function writeFileAtomicallySync<Handle>(
  fs: AtomicWriteFileSystemSync<Handle>,
  random: Random,
  file: string,
  content: FileContent,
  options: AtomicWriteOptionsSync,
): CreateOutcome | undefined {
  const publish = options.publish ?? 'replace';
  const mechanism = options.lock ?? hostKernelLock();
  const write = startWrite<SyncHandle>(mechanism, random, file);
  const { temporary } = write;
  const perform: Record<AtomicWriteStep, () => void> = {
    createLocked: () => {
      write.held = claimNewEntrySync(mechanism, temporary, 'entry');
      write.ownsTemporary = true;
      write.handle = openClaimedEntrySync(fs, write.held, temporary, options.mode);
    },
    lockSidecar: () => {
      write.held = claimNewEntrySync(mechanism, temporary, 'sidecar');
    },
    createTemporary: () => {
      write.handle = pathHandleSync(fs, fs.openSync(temporary, EXCLUSIVE_CREATE, options.mode));
      write.ownsTemporary = true;
    },
    write: () => {
      const handle = handleOf(write);
      try {
        handle.write(content);
        handle.sync();
      } finally {
        write.handle = undefined;
        handle.close();
      }
    },
    publish: () => {
      options.beforePublish?.();
      assertStillClaimed(write);
      if (publish === 'replace') fs.renameSync(temporary, file);
      else {
        try {
          fs.linkSync(temporary, file);
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
          write.created = false;
        }
      }
      if (write.created) options.afterPublish?.();
    },
    unlinkStaged: () => fs.rmSync(temporary),
    unlinkSidecar: () => {
      const held = heldOf(write);
      write.held = undefined;
      held.dispose();
    },
    release: () => {
      const held = write.held;
      write.held = undefined;
      held?.release();
    },
  };
  try {
    for (const step of atomicWriteSteps(write.form, publish)) {
      options.onStep?.(step);
      perform[step]();
    }
  } catch (error) {
    const handle = write.handle;
    write.handle = undefined;
    if (handle !== undefined) handle.close();
    if (write.held !== undefined && write.ownsTemporary) fs.rmSync(temporary);
    releaseAfterFailure(write);
    throw error;
  }
  syncDirectorySync(fs, path.dirname(file));
  return publish === 'create' ? { created: write.created } : undefined;
}
