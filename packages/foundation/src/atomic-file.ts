import path from 'node:path';
import type { Random } from './random.ts';

export type FileContent = string | Uint8Array;

export interface AtomicWriteFileHandle {
  writeFile(content: FileContent): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicWriteFileSystem {
  open(file: string, flags: string, mode?: number): Promise<AtomicWriteFileHandle>;
  rename(from: string, to: string): Promise<void>;
  link(from: string, to: string): Promise<void>;
  rm(file: string): Promise<void>;
}

export interface AtomicWriteFileSystemSync<Handle = string> {
  openSync(file: string, flags: string, mode?: number): Handle;
  writeFileSync(handle: Handle, content: FileContent): void;
  fsyncSync(handle: Handle): void;
  closeSync(handle: Handle): void;
  renameSync(from: string, to: string): void;
  linkSync(from: string, to: string): void;
  rmSync(file: string): void;
}

export type PublishMode = 'replace' | 'create';

export type AtomicWriteOptions = {
  mode: number;
  publish?: PublishMode;
  beforePublish?(): Promise<void>;
  afterPublish?(): Promise<void>;
};

export type AtomicWriteOptionsSync = {
  mode: number;
  publish?: PublishMode;
  beforePublish?(): void;
  afterPublish?(): void;
};

export type CreateOutcome = { created: boolean };

const TEMPORARY_SUFFIX_BYTES = 6;
const EXCLUSIVE_WRITE = 'wx';
const READ_ONLY = 'r';

const temporaryOf = (random: Random, file: string): string => `${file}.${process.pid}.${random.hex(TEMPORARY_SUFFIX_BYTES)}.tmp`;

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
  const temporary = temporaryOf(random, file);
  let created = true;
  try {
    const handle = await fs.open(temporary, EXCLUSIVE_WRITE, options.mode);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.beforePublish?.();
    if (publish === 'replace') await fs.rename(temporary, file);
    else {
      try {
        await fs.link(temporary, file);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        created = false;
      }
    }
    if (created) await options.afterPublish?.();
  } catch (error) {
    await fs.rm(temporary);
    throw error;
  }
  if (publish === 'create') await fs.rm(temporary);
  await syncDirectory(fs, path.dirname(file));
  return publish === 'create' ? { created } : undefined;
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
  const temporary = temporaryOf(random, file);
  let created = true;
  try {
    const handle = fs.openSync(temporary, EXCLUSIVE_WRITE, options.mode);
    try {
      fs.writeFileSync(handle, content);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    options.beforePublish?.();
    if (publish === 'replace') fs.renameSync(temporary, file);
    else {
      try {
        fs.linkSync(temporary, file);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        created = false;
      }
    }
    if (created) options.afterPublish?.();
  } catch (error) {
    fs.rmSync(temporary);
    throw error;
  }
  if (publish === 'create') fs.rmSync(temporary);
  syncDirectorySync(fs, path.dirname(file));
  return publish === 'create' ? { created } : undefined;
}
