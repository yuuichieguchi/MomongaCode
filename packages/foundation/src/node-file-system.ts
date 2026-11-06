import fs from 'node:fs';
import type { AtomicWriteFileSystem, AtomicWriteFileSystemSync } from './atomic-file.ts';
import { noFollowFlag } from './platform/privacy.ts';

export interface FileSystemSync extends AtomicWriteFileSystemSync<number> {
  openReadNoFollowSync(file: string): number;
  fstatSync(handle: number): fs.Stats;
  readFileSync(handle: number): Uint8Array;
  readdirSync(directory: string): string[];
}

export const nodeFileSystem: AtomicWriteFileSystem = {
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
  renameSync: (from, to) => fs.renameSync(from, to),
  linkSync: (from, to) => fs.linkSync(from, to),
  rmSync: (file) => fs.rmSync(file, { force: true }),
};
