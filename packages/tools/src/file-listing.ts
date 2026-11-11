import path from 'node:path';
import { FILE_CANDIDATE_LIMIT, directoryEntriesOf, findProgramOnPath } from '@momonga/foundation';
import type { FileCandidates, FileSystem } from '@momonga/foundation';
import type { ChildPorts } from './ports.ts';
import { readOnlyEnvironment } from './read-only-call.ts';

export type FileListingOptions = {
  root: string;
  env: Readonly<Record<string, string | undefined>>;
  trusted: boolean;
  signal: AbortSignal;
  limit?: number;
};

export type FileListingPorts = { child: Pick<ChildPorts, 'spawn'>; files: Pick<FileSystem, 'readdirEntries'> };

const GIT_LISTING = ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
const NUL = '\0';

const definedOf = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value] as const])));

const gitFor = (options: FileListingOptions): string | undefined => (options.trusted ? findProgramOnPath('git', options.env) : undefined);

const tracked = (ports: FileListingPorts, git: string, { root, env, signal, limit = FILE_CANDIDATE_LIMIT }: FileListingOptions): Promise<FileCandidates | undefined> =>
  new Promise((resolve, reject) => {
    const full = new AbortController();
    const child = ports.child.spawn(git, ['-C', root, ...GIT_LISTING], { env: readOnlyEnvironment(definedOf(env)), signal: AbortSignal.any([signal, full.signal]) });
    const entries: string[] = [];
    let rest = '';
    let truncated = false;
    child.stderr?.resume();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
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
    child.on('error', (error: Error) => {
      if (truncated) return;
      if (signal.aborted) reject(signal.reason);
      else reject(error);
    });
    child.on('close', (code: number | null) => {
      if (truncated) resolve({ entries, truncated });
      else if (signal.aborted) reject(signal.reason);
      else resolve(code === 0 ? { entries, truncated } : undefined);
    });
  });

const walked = async (ports: FileListingPorts, { root, signal, limit = FILE_CANDIDATE_LIMIT }: FileListingOptions): Promise<FileCandidates> => {
  const entries: string[] = [];
  const pending = [''];
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    for (const entry of await ports.files.readdirEntries(path.join(root, next))) {
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

export const fileCandidatesOn = async (ports: FileListingPorts, options: FileListingOptions): Promise<FileCandidates> => {
  const git = gitFor(options);
  return (git === undefined ? undefined : await tracked(ports, git, options)) ?? walked(ports, options);
};

export const directoryEntriesOn = async (ports: FileListingPorts, options: FileListingOptions): Promise<string[]> => {
  const git = gitFor(options);
  const listed = git === undefined ? undefined : await tracked(ports, git, options);
  if (listed !== undefined) return directoryEntriesOf(listed.entries);
  const entries = await ports.files.readdirEntries(options.root);
  return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort();
};
