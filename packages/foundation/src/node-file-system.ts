import fs from 'node:fs';
import type { AtomicWriteFileSystem, AtomicWriteFileSystemSync } from './atomic-file.ts';
import { noFollowFlag } from './platform/privacy.ts';

export const OPEN_FLAGS = {
  readOnly: fs.constants.O_RDONLY,
  readWrite: fs.constants.O_RDWR,
  create: fs.constants.O_CREAT,
  exclusive: fs.constants.O_EXCL,
  nonBlocking: fs.constants.O_NONBLOCK,
} as const;

export type DirectoryIdentity = { dev: bigint; ino: bigint };

export interface FileSystemSync extends AtomicWriteFileSystemSync<number> {
  openReadNoFollowSync(file: string): number;
  openDescriptorSync(file: string, flags: number, mode?: number): number;
  writeTextSync(handle: number, text: string): void;
  fstatSync(handle: number): fs.Stats;
  lstatSync(file: string): fs.Stats;
  identitySync(file: string): DirectoryIdentity;
  mkdirSync(directory: string, mode: number): void;
  readFileSync(handle: number): Uint8Array;
  readdirSync(directory: string): string[];
}

export interface FileSystem extends AtomicWriteFileSystem {
  readText(file: string): Promise<string>;
  readdir(directory: string): Promise<string[]>;
  openThenClose(file: string, flags: number): Promise<void>;
  writeByteAt(file: string, position: number, byte: string): Promise<void>;
}

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
  rm: (file) => fs.promises.rm(file, { force: true }),
  readText: (file) => fs.promises.readFile(file, 'utf8'),
  readdir: (directory) => fs.promises.readdir(directory),
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
  mkdirSync: (directory, mode) => void fs.mkdirSync(directory, { mode }),
  readFileSync: (handle) => new Uint8Array(fs.readFileSync(handle)),
  readdirSync: (directory) => fs.readdirSync(directory),
  renameSync: (from, to) => fs.renameSync(from, to),
  linkSync: (from, to) => fs.linkSync(from, to),
  rmSync: (file) => fs.rmSync(file, { force: true }),
};
