import fs from 'node:fs';
import type { AtomicWriteFileSystem, AtomicWriteFileSystemSync, FileContent } from './atomic-file.ts';
import { noFollowFlag } from './platform/privacy.ts';

export type AccessCheck = 'exists' | 'execute';

export type RemoveOptions = { readonly recursive: boolean };

export interface FileSystem extends AtomicWriteFileSystem {
  rm(file: string, options?: RemoveOptions): Promise<void>;
  stat(file: string): Promise<fs.Stats>;
  readdir(directory: string): Promise<string[]>;
  readdirEntries(directory: string): Promise<fs.Dirent[]>;
  readFile(file: string): Promise<Uint8Array>;
  readTextFile(file: string): Promise<string>;
  mkdir(directory: string): Promise<void>;
  writeFile(file: string, content: FileContent): Promise<void>;
  access(file: string): Promise<void>;
  cp(from: string, to: string): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
}

export interface FileSystemSync extends AtomicWriteFileSystemSync<number> {
  openReadNoFollowSync(file: string): number;
  fstatSync(handle: number): fs.Stats;
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
  readdir: (directory) => fs.promises.readdir(directory),
  readdirEntries: (directory) => fs.promises.readdir(directory, { withFileTypes: true }),
  readFile: async (file) => new Uint8Array(await fs.promises.readFile(file)),
  readTextFile: (file) => fs.promises.readFile(file, 'utf8'),
  mkdir: async (directory) => void (await fs.promises.mkdir(directory, { recursive: true })),
  writeFile: (file, content) => fs.promises.writeFile(file, content),
  access: (file) => fs.promises.access(file),
  cp: (from, to) => fs.promises.cp(from, to, { recursive: true, force: true }),
  mkdtemp: (prefix) => fs.promises.mkdtemp(prefix),
};

export const nodeFileSystemSync: FileSystemSync = {
  openSync: (file, flags, mode) => fs.openSync(file, flags, mode),
  openReadNoFollowSync: (file) => fs.openSync(file, fs.constants.O_RDONLY | noFollowFlag()),
  writeFileSync: (handle, content) => fs.writeFileSync(handle, content),
  fsyncSync: (handle) => fs.fsyncSync(handle),
  closeSync: (handle) => fs.closeSync(handle),
  fstatSync: (handle) => fs.fstatSync(handle),
  readFileSync: (handle) => new Uint8Array(fs.readFileSync(handle)),
  readdirSync: (directory) => fs.readdirSync(directory),
  statSync: (file) => fs.statSync(file),
  accessSync: (file, check) => fs.accessSync(file, accessMode(check)),
  mkdirSync: (directory, mode) => void fs.mkdirSync(directory, { recursive: true, mode }),
  renameSync: (from, to) => fs.renameSync(from, to),
  linkSync: (from, to) => fs.linkSync(from, to),
  rmSync: (file) => fs.rmSync(file, { force: true }),
};
