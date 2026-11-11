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

type OpenFile = { write(content: FileContent): unknown; sync(): unknown; close(): unknown };

type Write = {
  readonly form: LockForm;
  readonly temporary: string;
  held: HeldKernelLock | undefined;
  open: OpenFile | undefined;
  ownsTemporary: boolean;
  created: boolean;
};

const startWrite = (mechanism: KernelLockMechanism, random: Random, file: string): Write => ({
  form: lockFormOf(mechanism, 'file'),
  temporary: temporaryOf(random, file),
  held: undefined,
  open: undefined,
  ownsTemporary: false,
  created: true,
});

export class ClaimedDescriptorUnwritableError extends Error {
  constructor(entry: string) {
    super(`${entry} is locked through a descriptor, and the filesystem given to the writer cannot write through a descriptor, so the entry is not reopened by its path`);
    this.name = 'ClaimedDescriptorUnwritableError';
  }
}

const descriptorHandle = (writer: DescriptorWriter, descriptor: number): AtomicWriteFileHandle => ({
  writeFile: (content) => writer.write(descriptor, content),
  sync: () => writer.sync(descriptor),
  close: async () => undefined,
});

export const openClaimedEntry = async (fs: Pick<AtomicWriteFileSystem, 'open' | 'descriptors'>, held: HeldKernelLock, entry: string, mode: number): Promise<AtomicWriteFileHandle> => {
  if (held.descriptor === undefined) return fs.open(entry, EXCLUSIVE_CREATE, mode);
  if (fs.descriptors === undefined) throw new ClaimedDescriptorUnwritableError(entry);
  await fs.descriptors.chmod(held.descriptor, mode);
  return descriptorHandle(fs.descriptors, held.descriptor);
};

const openFileOf = (handle: AtomicWriteFileHandle): OpenFile => ({ write: (content) => handle.writeFile(content), sync: () => handle.sync(), close: () => handle.close() });

const pathFileSync = <Handle>(fs: AtomicWriteFileSystemSync<Handle>, handle: Handle): OpenFile => ({
  write: (content) => fs.writeFileSync(handle, content),
  sync: () => fs.fsyncSync(handle),
  close: () => fs.closeSync(handle),
});

const openClaimedEntrySync = <Handle>(fs: AtomicWriteFileSystemSync<Handle>, held: HeldKernelLock, entry: string, mode: number): OpenFile => {
  if (held.descriptor === undefined) return pathFileSync(fs, fs.openSync(entry, EXCLUSIVE_CREATE, mode));
  const writer = fs.descriptorsSync;
  const { descriptor } = held;
  if (writer === undefined) throw new ClaimedDescriptorUnwritableError(entry);
  writer.chmod(descriptor, mode);
  return { write: (content) => writer.write(descriptor, content), sync: () => writer.sync(descriptor), close: () => undefined };
};

export class ClaimedEntryReplacedError extends Error {
  constructor(entry: string) {
    super(`${entry} no longer names the file this writer locked, so it is not published`);
    this.name = 'ClaimedEntryReplacedError';
  }
}

const assertStillClaimed = (write: Write): void => {
  if (heldOf(write).stillNamed?.() !== false) return;
  write.ownsTemporary = false;
  throw new ClaimedEntryReplacedError(write.temporary);
};

const heldOf = (write: Write): HeldKernelLock => {
  if (write.held === undefined) throw new Error(`${write.temporary} has no lock at a step that needs it`);
  return write.held;
};

const openOf = (write: Write): OpenFile => {
  if (write.open === undefined) throw new Error(`${write.temporary} is not open at the write step`);
  return write.open;
};

const releaseAfterFailure = (write: Write): void => {
  const held = write.held;
  write.held = undefined;
  if (held === undefined) return;
  if (write.form === 'sidecar') held.dispose();
  else held.release();
};

export type AtomicWriteOperation =
  | { run: 'claim'; entry: string; form: LockForm }
  | { run: 'openClaimed'; held: HeldKernelLock; entry: string; mode: number }
  | { run: 'create'; file: string; mode: number }
  | { run: 'write'; open: OpenFile; content: FileContent }
  | { run: 'sync'; open: OpenFile }
  | { run: 'close'; open: OpenFile }
  | { run: 'beforePublish' }
  | { run: 'rename'; from: string; to: string }
  | { run: 'link'; from: string; to: string }
  | { run: 'afterPublish' }
  | { run: 'remove'; file: string }
  | { run: 'syncDirectory'; directory: string };

export type AtomicWriteSequence<Answer> = Generator<AtomicWriteOperation, Answer, unknown>;

export type AtomicWriteSequenceOptions = WriterLock & { mode: number; publish?: PublishMode };

function* run<Answer = void>(operation: AtomicWriteOperation): AtomicWriteSequence<Answer> {
  return (yield operation) as Answer;
}

function* stepsOf(write: Write, file: string, content: FileContent, options: AtomicWriteSequenceOptions, publish: PublishMode, step: AtomicWriteStep): AtomicWriteSequence<void> {
  const { temporary } = write;
  switch (step) {
    case 'createLocked':
      write.held = yield* run<HeldKernelLock>({ run: 'claim', entry: temporary, form: 'entry' });
      write.ownsTemporary = true;
      write.open = yield* run<OpenFile>({ run: 'openClaimed', held: write.held, entry: temporary, mode: options.mode });
      return;
    case 'lockSidecar':
      write.held = yield* run<HeldKernelLock>({ run: 'claim', entry: temporary, form: 'sidecar' });
      return;
    case 'createTemporary':
      write.open = yield* run<OpenFile>({ run: 'create', file: temporary, mode: options.mode });
      write.ownsTemporary = true;
      return;
    case 'write': {
      const open = openOf(write);
      try {
        yield* run({ run: 'write', open, content });
        yield* run({ run: 'sync', open });
      } finally {
        write.open = undefined;
        yield* run({ run: 'close', open });
      }
      return;
    }
    case 'publish':
      yield* run({ run: 'beforePublish' });
      assertStillClaimed(write);
      if (publish === 'replace') yield* run({ run: 'rename', from: temporary, to: file });
      else {
        try {
          yield* run({ run: 'link', from: temporary, to: file });
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
          write.created = false;
        }
      }
      if (write.created) yield* run({ run: 'afterPublish' });
      return;
    case 'unlinkStaged':
      yield* run({ run: 'remove', file: temporary });
      return;
    case 'unlinkSidecar': {
      const held = heldOf(write);
      write.held = undefined;
      held.dispose();
      return;
    }
    case 'release': {
      const held = write.held;
      write.held = undefined;
      held?.release();
      return;
    }
  }
}

export function* atomicWriteSequence(mechanism: KernelLockMechanism, random: Random, file: string, content: FileContent, options: AtomicWriteSequenceOptions): AtomicWriteSequence<CreateOutcome | undefined> {
  const publish = options.publish ?? 'replace';
  const write = startWrite(mechanism, random, file);
  try {
    for (const step of atomicWriteSteps(write.form, publish)) {
      options.onStep?.(step);
      yield* stepsOf(write, file, content, options, publish, step);
    }
  } catch (error) {
    const open = write.open;
    write.open = undefined;
    if (open !== undefined) yield* run({ run: 'close', open });
    if (write.held !== undefined && write.ownsTemporary) yield* run({ run: 'remove', file: write.temporary });
    releaseAfterFailure(write);
    throw error;
  }
  yield* run({ run: 'syncDirectory', directory: path.dirname(file) });
  return publish === 'create' ? { created: write.created } : undefined;
}

type AtomicWriteHost = {
  claim(entry: string, form: LockForm): unknown;
  openClaimed(held: HeldKernelLock, entry: string, mode: number): unknown;
  create(file: string, mode: number): unknown;
  beforePublish(): unknown;
  rename(from: string, to: string): unknown;
  link(from: string, to: string): unknown;
  afterPublish(): unknown;
  remove(file: string): unknown;
  syncDirectory(directory: string): unknown;
};

const performed = (host: AtomicWriteHost, operation: AtomicWriteOperation): unknown => {
  switch (operation.run) {
    case 'claim':
      return host.claim(operation.entry, operation.form);
    case 'openClaimed':
      return host.openClaimed(operation.held, operation.entry, operation.mode);
    case 'create':
      return host.create(operation.file, operation.mode);
    case 'write':
      return operation.open.write(operation.content);
    case 'sync':
      return operation.open.sync();
    case 'close':
      return operation.open.close();
    case 'beforePublish':
      return host.beforePublish();
    case 'rename':
      return host.rename(operation.from, operation.to);
    case 'link':
      return host.link(operation.from, operation.to);
    case 'afterPublish':
      return host.afterPublish();
    case 'remove':
      return host.remove(operation.file);
    case 'syncDirectory':
      return host.syncDirectory(operation.directory);
  }
};

const performedNow = <Answer>(work: AtomicWriteSequence<Answer>, host: AtomicWriteHost): Answer => {
  let turn = work.next();
  while (turn.done !== true) {
    let answer: unknown;
    try {
      answer = performed(host, turn.value);
    } catch (error) {
      turn = work.throw(error);
      continue;
    }
    turn = work.next(answer);
  }
  return turn.value;
};

const performedLater = async <Answer>(work: AtomicWriteSequence<Answer>, host: AtomicWriteHost): Promise<Answer> => {
  let turn = work.next();
  while (turn.done !== true) {
    let answer: unknown;
    try {
      answer = await performed(host, turn.value);
    } catch (error) {
      turn = work.throw(error);
      continue;
    }
    turn = work.next(answer);
  }
  return turn.value;
};

export function writeFileAtomically(
  fs: AtomicWriteFileSystem,
  random: Random,
  file: string,
  content: FileContent,
  options: AtomicWriteOptions & { publish: 'create' },
): Promise<CreateOutcome>;
export function writeFileAtomically(fs: AtomicWriteFileSystem, random: Random, file: string, content: FileContent, options: AtomicWriteOptions): Promise<CreateOutcome | undefined>;
export function writeFileAtomically(fs: AtomicWriteFileSystem, random: Random, file: string, content: FileContent, options: AtomicWriteOptions): Promise<CreateOutcome | undefined> {
  const mechanism = options.lock ?? hostKernelLock();
  return performedLater(atomicWriteSequence(mechanism, random, file, content, options), {
    claim: (entry, form) => claimNewEntry(mechanism, entry, form),
    openClaimed: async (held, entry, mode) => openFileOf(await openClaimedEntry(fs, held, entry, mode)),
    create: async (created, mode) => openFileOf(await fs.open(created, EXCLUSIVE_CREATE, mode)),
    beforePublish: () => options.beforePublish?.(),
    rename: (from, to) => fs.rename(from, to),
    link: (from, to) => fs.link(from, to),
    afterPublish: () => options.afterPublish?.(),
    remove: (removed) => fs.rm(removed),
    syncDirectory: (directory) => syncDirectory(fs, directory),
  });
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
  const mechanism = options.lock ?? hostKernelLock();
  return performedNow(atomicWriteSequence(mechanism, random, file, content, options), {
    claim: (entry, form) => claimNewEntrySync(mechanism, entry, form),
    openClaimed: (held, entry, mode) => openClaimedEntrySync(fs, held, entry, mode),
    create: (created, mode) => pathFileSync(fs, fs.openSync(created, EXCLUSIVE_CREATE, mode)),
    beforePublish: () => options.beforePublish?.(),
    rename: (from, to) => fs.renameSync(from, to),
    link: (from, to) => fs.linkSync(from, to),
    afterPublish: () => options.afterPublish?.(),
    remove: (removed) => fs.rmSync(removed),
    syncDirectory: (directory) => syncDirectorySync(fs, directory),
  });
}
