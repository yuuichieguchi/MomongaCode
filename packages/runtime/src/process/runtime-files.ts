import fs from 'node:fs';

export type RuntimeFiles = {
  readdir(dir: string): Promise<string[]>;
  lstat(entry: string): Promise<fs.Stats>;
  unlink(entry: string): Promise<void>;
  removeTree(entry: string): Promise<void>;
  lstatSync(entry: string): fs.Stats;
  unlinkSync(entry: string): void;
  renameSync(from: string, to: string): void;
};

export const nodeRuntimeFiles: RuntimeFiles = {
  readdir: (dir) => fs.promises.readdir(dir),
  lstat: (entry) => fs.promises.lstat(entry),
  unlink: (entry) => fs.promises.unlink(entry),
  removeTree: (entry) => fs.promises.rm(entry, { recursive: true, force: true }),
  lstatSync: (entry) => fs.lstatSync(entry),
  unlinkSync: (entry) => fs.unlinkSync(entry),
  renameSync: (from, to) => fs.renameSync(from, to),
};
