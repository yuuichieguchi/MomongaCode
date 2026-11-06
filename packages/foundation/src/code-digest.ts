import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

export type CodeOrigin = { loadedFrom: string; isSea: boolean; execPath: string };

const sha256Of = (content: string | Uint8Array): string => createHash('sha256').update(content).digest('hex');

const filesUnder = async (directory: string, extension: string): Promise<string[]> => {
  const found = await fs.readdir(directory, { recursive: true, encoding: 'utf8' });
  return found.filter((relative) => relative.endsWith(extension) && !relative.split(path.sep).includes('node_modules')).map((relative) => path.join(directory, relative));
};

const sourceFilesOf = async (packagesDirectory: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await fs.readdir(packagesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDirectory = path.join(packagesDirectory, entry.name);
    const hasSource = (await fs.readdir(packageDirectory)).includes('src');
    files.push(...(hasSource ? await filesUnder(path.join(packageDirectory, 'src'), '.ts') : await filesUnder(packageDirectory, '.js')));
  }
  return files;
};

const digestOfSources = async (loadedFrom: string): Promise<string> => {
  const packagesDirectory = path.resolve(path.dirname(loadedFrom), '..', '..');
  const root = path.dirname(packagesDirectory);
  const entries: string[] = [];
  for (const file of await sourceFilesOf(packagesDirectory)) {
    const name = path.relative(root, file).split(path.sep).join('/');
    entries.push(`${name}\0${sha256Of(await fs.readFile(file))}\n`);
  }
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
