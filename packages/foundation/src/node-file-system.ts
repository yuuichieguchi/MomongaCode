import fs from 'node:fs';
import type { AtomicWriteFileSystem, AtomicWriteFileSystemSync, DescriptorWriter, DescriptorWriterSync, FileContent } from './atomic-file.ts';
import { PRIVATE_MODE, assertPrivateRegularFile, noFollowFlag } from './platform/privacy.ts';

export const OPEN_FLAGS = {
  readOnly: fs.constants.O_RDONLY,
  readWrite: fs.constants.O_RDWR,
  writeOnly: fs.constants.O_WRONLY,
  create: fs.constants.O_CREAT,
  exclusive: fs.constants.O_EXCL,
  truncate: fs.constants.O_TRUNC,
  nonBlocking: fs.constants.O_NONBLOCK,
  noFollow: noFollowFlag(),
} as const;

export type DirectoryIdentity = { dev: bigint; ino: bigint };

export type AccessCheck = 'exists' | 'execute' | 'list';

export type DirectoryReader = { read(): Promise<string | null>; close(): Promise<void> };

export type RemoveOptions = { readonly recursive: boolean };

export type ReadHandle = { stat(): Promise<fs.Stats>; chmod(mode: number): Promise<void>; read(page: Uint8Array): Promise<number>; readAt(page: Uint8Array, position: number): Promise<number>; close(): Promise<void> };

export interface FileSystem extends AtomicWriteFileSystem {
  rm(file: string, options?: RemoveOptions): Promise<void>;
  stat(file: string): Promise<fs.Stats>;
  lstat(file: string): Promise<fs.Stats>;
  readdir(directory: string): Promise<string[]>;
  readdirEntries(directory: string): Promise<fs.Dirent[]>;
  readFile(file: string): Promise<Uint8Array>;
  readTextFile(file: string): Promise<string>;
  mkdir(directory: string, mode?: number): Promise<void>;
  mkdirPrivate(directory: string): Promise<void>;
  chmod(target: string, mode: number): Promise<void>;
  readOwnerOnlyTextFile(file: string, description: string, maxBytes?: number): Promise<string | undefined>;
  writeFile(file: string, content: FileContent): Promise<void>;
  access(file: string, check?: AccessCheck): Promise<void>;
  readlink(file: string): Promise<string>;
  readlinkBytes(file: string): Promise<Uint8Array>;
  readStart(file: string, bytes: number): Promise<Uint8Array>;
  readRange(file: string, position: number, length: number): Promise<Uint8Array>;
  openRead(file: string, flags: number): Promise<ReadHandle>;
  makeDirectory(directory: string, mode?: number): Promise<void>;
  removeEmptyDirectory(directory: string): Promise<void>;
  realpath(file: string): Promise<string>;
  openDirectory(directory: string): Promise<DirectoryReader>;
  cp(from: string, to: string): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  openThenClose(file: string, flags: number): Promise<void>;
  writeByteAt(file: string, position: number, byte: string): Promise<void>;
  identity(file: string): Promise<DirectoryIdentity>;
}

export interface FileSystemSync extends AtomicWriteFileSystemSync<number> {
  openReadNoFollowSync(file: string): number;
  openDescriptorSync(file: string, flags: number, mode?: number): number;
  writeTextSync(handle: number, text: string): void;
  fstatSync(handle: number): fs.Stats;
  lstatSync(file: string): fs.Stats;
  identitySync(file: string): DirectoryIdentity;
  readFileSync(handle: number): Uint8Array;
  readdirSync(directory: string): string[];
  statSync(file: string): fs.Stats;
  accessSync(file: string, check: AccessCheck): void;
  mkdirSync(directory: string, mode: number): void;
  readlinkSync(file: string): string;
  realpathSync(file: string): string;
  readAtSync(handle: number, page: Uint8Array, position: number): number;
  truncateSync(handle: number, length: number): void;
  writeTextAtSync(handle: number, text: string, position: number): void;
  lstatBigIntSync(file: string): fs.BigIntStats;
  fstatBigIntSync(handle: number): fs.BigIntStats;
  unlinkSync(file: string): void;
  readTextFileSync(file: string): string;
  makeDirectorySync(directory: string, mode: number): void;
  removeTreeSync(directory: string): void;
}

const ACCESS_MODES: Readonly<Record<AccessCheck, number>> = { exists: fs.constants.F_OK, execute: fs.constants.X_OK, list: fs.constants.R_OK | fs.constants.X_OK };

const accessMode = (check: AccessCheck): number => ACCESS_MODES[check];

const bytesOf = (content: FileContent): Uint8Array => (typeof content === 'string' ? Buffer.from(content, 'utf8') : content);

const writeAllAt = (descriptor: number, bytes: Uint8Array, offset: number): Promise<void> =>
  new Promise((resolve, reject) => {
    if (offset >= bytes.length) {
      resolve();
      return;
    }
    fs.write(descriptor, bytes, offset, bytes.length - offset, null, (error, written) => {
      if (error !== null) reject(error);
      else resolve(writeAllAt(descriptor, bytes, offset + written));
    });
  });

const promised = (run: (done: (error: NodeJS.ErrnoException | null) => void) => void): Promise<void> =>
  new Promise((resolve, reject) => run((error) => (error === null ? resolve() : reject(error))));

export const nodeDescriptorWriter: DescriptorWriter = {
  write: (descriptor, content) => writeAllAt(descriptor, bytesOf(content), 0),
  sync: (descriptor) => promised((done) => fs.fsync(descriptor, done)),
  chmod: (descriptor, mode) => promised((done) => fs.fchmod(descriptor, mode, done)),
};

export const nodeDescriptorWriterSync: DescriptorWriterSync = {
  write: (descriptor, content) => fs.writeFileSync(descriptor, content),
  sync: (descriptor) => fs.fsyncSync(descriptor),
  chmod: (descriptor, mode) => fs.fchmodSync(descriptor, mode),
};

export const readFileHead = async (file: string, maxBytes: number): Promise<Uint8Array> => {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

export const nodeFileSystem: FileSystem = {
  descriptors: nodeDescriptorWriter,
  open: async (file, flags, mode) => {
    const handle = await fs.promises.open(file, flags, mode);
    if (mode !== undefined) await handle.chmod(mode);
    return {
      writeFile: (content) => handle.writeFile(content),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  rename: (from, to) => fs.promises.rename(from, to),
  link: (from, to) => fs.promises.link(from, to),
  rm: (file, options) => fs.promises.rm(file, { force: true, recursive: options?.recursive === true }),
  stat: (file) => fs.promises.stat(file),
  lstat: (file) => fs.promises.lstat(file),
  readdir: (directory) => fs.promises.readdir(directory),
  readdirEntries: (directory) => fs.promises.readdir(directory, { withFileTypes: true }),
  readFile: async (file) => new Uint8Array(await fs.promises.readFile(file)),
  readTextFile: (file) => fs.promises.readFile(file, 'utf8'),
  mkdir: async (directory, mode) => void (await fs.promises.mkdir(directory, { recursive: true, ...(mode === undefined ? {} : { mode }) })),
  chmod: (target, mode) => fs.promises.chmod(target, mode),
  mkdirPrivate: async (directory) => {
    await fs.promises.mkdir(directory, { recursive: true, mode: PRIVATE_MODE.directory });
    await fs.promises.chmod(directory, PRIVATE_MODE.directory);
  },
  readOwnerOnlyTextFile: async (file, description, maxBytes) => {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(file, fs.constants.O_RDONLY | noFollowFlag());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const stat = await handle.stat();
      assertPrivateRegularFile(stat, description);
      if (maxBytes !== undefined && stat.size > maxBytes) throw new Error(`${description} is larger than ${maxBytes} bytes`);
      return await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
  },
  writeFile: (file, content) => fs.promises.writeFile(file, content),
  access: (file, check = 'exists') => fs.promises.access(file, accessMode(check)),
  readlink: (file) => fs.promises.readlink(file),
  readlinkBytes: (file) => fs.promises.readlink(file, 'buffer'),
  readStart: async (file, bytes) => {
    const handle = await fs.promises.open(file, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
  readRange: async (file, position, length) => {
    const handle = await fs.promises.open(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return buffer.subarray(0, filled);
    } finally {
      await handle.close();
    }
  },
  openRead: async (file, flags) => {
    const handle = await fs.promises.open(file, flags);
    return {
      stat: () => handle.stat(),
      chmod: (mode) => handle.chmod(mode),
      read: async (page) => (await handle.read(page, 0, page.length, null)).bytesRead,
      readAt: async (page, position) => (await handle.read(page, 0, page.length, position)).bytesRead,
      close: () => handle.close(),
    };
  },
  makeDirectory: async (directory, mode) => void (await fs.promises.mkdir(directory, mode === undefined ? {} : { mode })),
  removeEmptyDirectory: (directory) => fs.promises.rmdir(directory),
  realpath: (file) => fs.promises.realpath(file),
  openDirectory: async (directory) => {
    const handle = await fs.promises.opendir(directory);
    return { read: async () => (await handle.read())?.name ?? null, close: () => handle.close() };
  },
  cp: (from, to) => fs.promises.cp(from, to, { recursive: true, force: true }),
  mkdtemp: (prefix) => fs.promises.mkdtemp(prefix),
  openThenClose: async (file, flags) => {
    const handle = await fs.promises.open(file, flags);
    await handle.close();
  },
  writeByteAt: async (file, position, byte) => {
    const handle = await fs.promises.open(file, 'r+');
    try {
      await handle.write(byte, position, 'utf8');
      await handle.datasync();
    } finally {
      await handle.close();
    }
  },
  identity: async (file) => {
    const stat = await fs.promises.stat(file, { bigint: true });
    return { dev: stat.dev, ino: stat.ino };
  },
};

export const nodeFileSystemSync: FileSystemSync = {
  descriptorsSync: nodeDescriptorWriterSync,
  openSync: (file, flags, mode) => {
    const descriptor = fs.openSync(file, flags, mode);
    if (mode !== undefined) fs.fchmodSync(descriptor, mode);
    return descriptor;
  },
  openReadNoFollowSync: (file) => fs.openSync(file, fs.constants.O_RDONLY | noFollowFlag()),
  openDescriptorSync: (file, flags, mode) => fs.openSync(file, flags, mode),
  writeFileSync: (handle, content) => fs.writeFileSync(handle, content),
  writeTextSync: (handle, text) => void fs.writeSync(handle, text),
  fsyncSync: (handle) => fs.fsyncSync(handle),
  closeSync: (handle) => fs.closeSync(handle),
  fstatSync: (handle) => fs.fstatSync(handle),
  lstatSync: (file) => fs.lstatSync(file),
  identitySync: (file) => {
    const stat = fs.statSync(file, { bigint: true });
    return { dev: stat.dev, ino: stat.ino };
  },
  readFileSync: (handle) => new Uint8Array(fs.readFileSync(handle)),
  readdirSync: (directory) => fs.readdirSync(directory),
  statSync: (file) => fs.statSync(file),
  accessSync: (file, check) => fs.accessSync(file, accessMode(check)),
  mkdirSync: (directory, mode) => void fs.mkdirSync(directory, { recursive: true, mode }),
  readlinkSync: (file) => fs.readlinkSync(file),
  realpathSync: (file) => fs.realpathSync.native(file),
  renameSync: (from, to) => fs.renameSync(from, to),
  linkSync: (from, to) => fs.linkSync(from, to),
  rmSync: (file) => fs.rmSync(file, { force: true }),
  readAtSync: (handle, page, position) => fs.readSync(handle, page, 0, page.length, position),
  truncateSync: (handle, length) => fs.ftruncateSync(handle, length),
  writeTextAtSync: (handle, text, position) => void fs.writeSync(handle, text, position),
  lstatBigIntSync: (file) => fs.lstatSync(file, { bigint: true }),
  fstatBigIntSync: (handle) => fs.fstatSync(handle, { bigint: true }),
  unlinkSync: (file) => fs.unlinkSync(file),
  readTextFileSync: (file) => fs.readFileSync(file, 'utf8'),
  makeDirectorySync: (directory, mode) => void fs.mkdirSync(directory, { mode }),
  removeTreeSync: (directory) => fs.rmSync(directory, { recursive: true, force: true }),
};

export const readFileBytesSync = (file: string): Uint8Array => fs.readFileSync(file);

export const openReadOnlySync = (file: string): number => fs.openSync(file, 'r');

export const closeDescriptorSync = (descriptor: number): void => fs.closeSync(descriptor);
