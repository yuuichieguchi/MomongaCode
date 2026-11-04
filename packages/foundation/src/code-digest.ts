import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

export type CodeOrigin = { loadedFrom: string; isSea: boolean; execPath: string };

const sha256Of = (content: string | Uint8Array): string => createHash('sha256').update(content).digest('hex');

const sourceFilesOf = async (packagesDirectory: string): Promise<string[]> => {
  const files: string[] = [];
  for (const entry of await fs.readdir(packagesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = path.join(packagesDirectory, entry.name, 'src');
    const found = await fs.readdir(source, { recursive: true, encoding: 'utf8' });
    for (const relative of found) if (relative.endsWith('.ts')) files.push(path.join(source, relative));
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
