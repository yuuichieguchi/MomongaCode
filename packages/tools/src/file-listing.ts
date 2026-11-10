import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FILE_CANDIDATE_LIMIT, directoryEntriesOf, findProgramOnPath } from '@momonga/foundation';
import type { FileCandidates } from '@momonga/foundation';
import { readOnlyEnvironment } from './read-only-call.ts';

export type FileListingOptions = {
  root: string;
  env: Readonly<Record<string, string | undefined>>;
  trusted: boolean;
  signal: AbortSignal;
  limit?: number;
};

const GIT_LISTING = ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
const NUL = '\0';

const definedOf = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value] as const])));

const gitFor = (options: FileListingOptions): string | undefined => (options.trusted ? findProgramOnPath('git', options.env) : undefined);

const tracked = (git: string, { root, env, signal, limit = FILE_CANDIDATE_LIMIT }: FileListingOptions): Promise<FileCandidates | undefined> =>
  new Promise((resolve, reject) => {
    const full = new AbortController();
    const child = spawn(git, ['-C', root, ...GIT_LISTING], { env: readOnlyEnvironment(definedOf(env)), stdio: ['ignore', 'pipe', 'ignore'], signal: AbortSignal.any([signal, full.signal]) });
    const entries: string[] = [];
    let rest = '';
    let truncated = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (truncated) return;
      const parts = `${rest}${chunk}`.split(NUL);
      rest = parts.pop() ?? '';
      for (const part of parts) {
        if (entries.length === limit) {
          truncated = true;
          full.abort();
          return;
        }
        entries.push(part);
      }
    });
    child.on('error', (error) => {
      if (truncated) return;
      if (signal.aborted) reject(signal.reason);
      else reject(error);
    });
    child.on('close', (code) => {
      if (truncated) resolve({ entries, truncated });
      else if (signal.aborted) reject(signal.reason);
      else resolve(code === 0 ? { entries, truncated } : undefined);
    });
  });

const walked = async ({ root, signal, limit = FILE_CANDIDATE_LIMIT }: FileListingOptions): Promise<FileCandidates> => {
  const entries: string[] = [];
  const pending = [''];
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    const directory = await fs.promises.opendir(path.join(root, next));
    for await (const entry of directory) {
      signal.throwIfAborted();
      const relative = next === '' ? entry.name : `${next}/${entry.name}`;
      if (entry.isDirectory()) {
        pending.push(relative);
        continue;
      }
      if (entries.length === limit) return { entries, truncated: true };
      entries.push(relative);
    }
  }
  return { entries, truncated: false };
};

export const listFileCandidates = async (options: FileListingOptions): Promise<FileCandidates> => {
  const git = gitFor(options);
  return (git === undefined ? undefined : await tracked(git, options)) ?? walked(options);
};

export const listDirectoryEntries = async (options: FileListingOptions): Promise<string[]> => {
  const git = gitFor(options);
  const listed = git === undefined ? undefined : await tracked(git, options);
  if (listed !== undefined) return directoryEntriesOf(listed.entries);
  const entries = await fs.promises.readdir(options.root, { withFileTypes: true });
  return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort();
};
