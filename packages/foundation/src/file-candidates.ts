import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findProgramOnPath } from './program-search.ts';

export const FILE_CANDIDATE_LIMIT = 50_000;

export type FileCandidates = { entries: string[]; truncated: boolean };

export type FileCandidateOptions = {
  root: string;
  env: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
  limit?: number;
};

const GIT_LISTING = ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
const NUL = '\0';

const tracked = (git: string, { root, env, signal, limit = FILE_CANDIDATE_LIMIT }: FileCandidateOptions): Promise<FileCandidates | undefined> =>
  new Promise((resolve, reject) => {
    const full = new AbortController();
    const child = spawn(git, ['-C', root, ...GIT_LISTING], { env: { ...env }, stdio: ['ignore', 'pipe', 'ignore'], signal: AbortSignal.any([signal, full.signal]) });
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

const walked = async ({ root, signal, limit = FILE_CANDIDATE_LIMIT }: FileCandidateOptions): Promise<FileCandidates> => {
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

export const listFileCandidates = async (options: FileCandidateOptions): Promise<FileCandidates> => {
  const git = findProgramOnPath('git', options.env);
  return (git === undefined ? undefined : await tracked(git, options)) ?? walked(options);
};

export const directoryEntriesOf = (files: readonly string[]): string[] => {
  const names = new Set<string>();
  for (const file of files) {
    const slash = file.indexOf('/');
    names.add(slash < 0 ? file : file.slice(0, slash + 1));
  }
  return [...names].sort();
};

export const listDirectoryEntries = async (options: FileCandidateOptions): Promise<string[]> => {
  const git = findProgramOnPath('git', options.env);
  const listed = git === undefined ? undefined : await tracked(git, options);
  if (listed !== undefined) return directoryEntriesOf(listed.entries);
  const entries = await fs.promises.readdir(options.root, { withFileTypes: true });
  return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort();
};
