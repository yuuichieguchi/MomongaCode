import fs from 'node:fs';
import { nodeFileSystem } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';

export type RuntimeFiles = Pick<FileSystem, 'readdir' | 'rm'> & {
  lstat(entry: string): Promise<fs.Stats>;
  unlink(entry: string): Promise<void>;
  lstatSync(entry: string): fs.Stats;
  unlinkSync(entry: string): void;
  renameSync(from: string, to: string): void;
};

export const nodeRuntimeFiles: RuntimeFiles = {
  readdir: nodeFileSystem.readdir,
  lstat: (entry) => fs.promises.lstat(entry),
  unlink: (entry) => fs.promises.unlink(entry),
  rm: nodeFileSystem.rm,
  lstatSync: (entry) => fs.lstatSync(entry),
  unlinkSync: (entry) => fs.unlinkSync(entry),
  renameSync: (from, to) => fs.renameSync(from, to),
};
