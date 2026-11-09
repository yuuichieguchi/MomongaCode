import fs from 'node:fs';
import type { AtomicWriteFileSystem, AtomicWriteFileSystemSync, FileContent } from './atomic-file.ts';
import { noFollowFlag } from './platform/privacy.ts';

export const OPEN_FLAGS = {
  readOnly: fs.constants.O_RDONLY,
  readWrite: fs.constants.O_RDWR,
  create: fs.constants.O_CREAT,
  exclusive: fs.constants.O_EXCL,
  nonBlocking: fs.constants.O_NONBLOCK,
} as const;

export type DirectoryIdentity = { dev: bigint; ino: bigint };

export type AccessCheck = 'exists' | 'execute';

export type RemoveOptions = { readonly recursive: boolean };

export interface FileSystem extends AtomicWriteFileSystem {
  rm(file: string, options?: RemoveOptions): Promise<void>;
  stat(file: string): Promise<fs.Stats>;
  lstat(file: string): Promise<fs.Stats>;
  readdir(directory: string): Promise<string[]>;
  readdirEntries(directory: string): Promise<fs.Dirent[]>;
  readFile(file: string): Promise<Uint8Array>;
  readTextFile(file: string): Promise<string>;
  mkdir(directory: string, mode?: number): Promise<void>;
  writeFile(file: string, content: FileContent): Promise<void>;
  access(file: string): Promise<void>;
  cp(from: string, to: string): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  openThenClose(file: string, flags: number): Promise<void>;
  writeByteAt(file: string, position: number, byte: string): Promise<void>;
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
}

const accessMode = (check: AccessCheck): number => (check === 'execute' ? fs.constants.X_OK : fs.constants.F_OK);

export const nodeFileSystem: FileSystem = {
  open: async (file, flags, mode) => {
    const handle = await fs.promises.open(file, flags, mode);
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
  mkdir: async (directory, mode) => void (await fs.promises.mkdir(directory, mode === undefined ? { recursive: true } : { recursive: true, mode })),
  writeFile: (file, content) => fs.promises.writeFile(file, content),
  access: (file) => fs.promises.access(file),
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
};

export const nodeFileSystemSync: FileSystemSync = {
  openSync: (file, flags, mode) => fs.openSync(file, flags, mode),
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
  renameSync: (from, to) => fs.renameSync(from, to),
  linkSync: (from, to) => fs.linkSync(from, to),
  rmSync: (file) => fs.rmSync(file, { force: true }),
};
