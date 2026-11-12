import { createHash } from 'node:crypto';
import path from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import { nodeFileSystem as fs } from './node-file-system.ts';

export type CodeOrigin = { loadedFrom: string; isSea: boolean; execPath: string };

const sha256Of = (content: string | Uint8Array): string => createHash('sha256').update(content).digest('hex');

const NODE_MODULES = 'node_modules';

const filesUnder = async (directory: string, extension: string): Promise<string[]> => {
  const found: string[] = [];
  for (const entry of await fs.readdirEntries(directory)) {
    if (entry.name === NODE_MODULES) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(target, extension)));
    else if (entry.name.endsWith(extension)) found.push(target);
  }
  return found;
};

const sourceFilesOf = async (packagesDirectory: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await fs.readdirEntries(packagesDirectory)) {
    if (!entry.isDirectory()) continue;
    const packageDirectory = path.join(packagesDirectory, entry.name);
    const hasSource = (await fs.readdir(packageDirectory)).includes('src');
    files.push(...(hasSource ? await filesUnder(path.join(packageDirectory, 'src'), '.ts') : await filesUnder(packageDirectory, '.js')));
  }
  return files;
};

const SOURCE_READ_WIDTH = 16;

const digestOfSources = async (loadedFrom: string): Promise<string> => {
  const packagesDirectory = path.resolve(path.dirname(loadedFrom), '..', '..');
  const root = path.dirname(packagesDirectory);
  const files = await sourceFilesOf(packagesDirectory);
  const entries: string[] = [];
  let next = 0;
  const readLane = async (): Promise<void> => {
    while (next < files.length) {
      const file = files[next] as string;
      next += 1;
      const name = path.relative(root, file).split(path.sep).join('/');
      entries.push(`${name}\0${sha256Of(await fs.readFile(file))}\n`);
    }
  };
  await Promise.all(Array.from({ length: SOURCE_READ_WIDTH }, readLane));
  return sha256Of(entries.sort().join(''));
};

export const codeDigestOf = async (origin: CodeOrigin): Promise<string> => {
  if (origin.isSea) return sha256Of(await fs.readFile(origin.execPath));
  const loadedFrom = await fs.realpath(origin.loadedFrom);
  if (loadedFrom.endsWith('.ts')) return digestOfSources(loadedFrom);
  return sha256Of(await fs.readFile(loadedFrom));
};

let runningProcessDigest: Promise<string> | undefined;

export const codeDigestOfRunningProcess = (): Promise<string> => {
  runningProcessDigest ??= codeDigestOf({ loadedFrom: fileURLToPath(import.meta.url), isSea: isSea(), execPath: process.execPath });
  return runningProcessDigest;
};
