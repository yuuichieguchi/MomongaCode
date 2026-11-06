import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolFile } from '@momonga/protocol';

export type WorkTreeMark = { readonly tree: string };

export type ObservedFile = { path: string; change: 'write' | 'remove' };

export type ObservedWindow = { files: ObservedFile[]; mark: WorkTreeMark };

export type WorkTreeObserver = {
  mark(signal: AbortSignal): Promise<WorkTreeMark | undefined>;
  changedSince(mark: WorkTreeMark, signal: AbortSignal): Promise<ObservedWindow | undefined>;
};

export type GitWorkTreeObserverOptions = { storeDir: string; workTree: string; trusted: boolean };

export const OBSERVED_FILE_HASH_PAGE_BYTES = 1024 * 1024;

const GIT_DIRECTORY_ENTRY = '.git';
const TREE_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LANG: 'C' } as const;

let observersCreated = 0;

const runGit = (args: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Buffer | undefined> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve(undefined);
      return;
    }
    const chunks: Buffer[] = [];
    const child = spawn('git', [...args], { env, stdio: ['ignore', 'pipe', 'ignore'], signal });
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => resolve(code === 0 ? Buffer.concat(chunks) : undefined));
  });

const isWorkTree = async (workTree: string): Promise<boolean> => {
  try {
    await fs.promises.stat(path.join(workTree, GIT_DIRECTORY_ENTRY));
    return true;
  } catch {
    return false;
  }
};

const changesOf = (workTree: string, nameStatus: string): ObservedFile[] => {
  const fields = nameStatus.split('\0');
  const files: ObservedFile[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index] as string;
    const relative = fields[index + 1] as string;
    files.push({ path: path.join(workTree, relative), change: status.startsWith('D') ? 'remove' : 'write' });
  }
  return files;
};

export const createGitWorkTreeObserver = ({ storeDir, workTree, trusted }: GitWorkTreeObserverOptions): WorkTreeObserver => {
  observersCreated += 1;
  const indexFile = path.join(storeDir, `index-${process.pid}-${observersCreated}`);
  const env: NodeJS.ProcessEnv = {
    ...(process.env['PATH'] === undefined ? {} : { PATH: process.env['PATH'] }),
    ...GIT_ENV,
    GIT_DIR: storeDir,
    GIT_WORK_TREE: workTree,
    GIT_INDEX_FILE: indexFile,
  };
  let initialised: Promise<boolean> | undefined;

  const ready = (signal: AbortSignal): Promise<boolean> => {
    initialised ??= (async () => {
      if (!trusted || !(await isWorkTree(workTree))) return false;
      if (fs.existsSync(path.join(storeDir, 'HEAD'))) return true;
      await fs.promises.mkdir(storeDir, { recursive: true, mode: 0o700 });
      return (await runGit(['init', '-q'], env, signal)) !== undefined;
    })();
    return initialised;
  };

  const snapshot = async (signal: AbortSignal): Promise<WorkTreeMark | undefined> => {
    if (!(await ready(signal))) return undefined;
    if ((await runGit(['add', '-A', '--', '.'], env, signal)) === undefined) return undefined;
    const written = await runGit(['write-tree'], env, signal);
    const tree = written?.toString('utf8').trim();
    return tree === undefined || !TREE_ID.test(tree) ? undefined : { tree };
  };

  return {
    mark: snapshot,
    changedSince: async (mark, signal) => {
      const closing = await snapshot(signal);
      if (closing === undefined) return undefined;
      const diff = await runGit(['diff-tree', '-r', '--name-status', '-z', '--no-renames', mark.tree, closing.tree], env, signal);
      return diff === undefined ? undefined : { files: changesOf(workTree, diff.toString('utf8')), mark: closing };
    },
  };
};

const sha256Paged = async (file: string, signal: AbortSignal): Promise<string | undefined> => {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    const hash = createHash('sha256');
    const page = Buffer.alloc(OBSERVED_FILE_HASH_PAGE_BYTES);
    for (;;) {
      if (signal.aborted) return undefined;
      const { bytesRead } = await handle.read(page, 0, page.length, null);
      if (bytesRead === 0) return hash.digest('hex');
      hash.update(page.subarray(0, bytesRead));
    }
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
};

export const observedToolFiles = async (files: readonly ObservedFile[], signal: AbortSignal): Promise<ToolFile[]> => {
  const observed: ToolFile[] = [];
  for (const file of files) {
    if (file.change === 'remove') {
      observed.push({ path: file.path, access: 'remove' });
      continue;
    }
    const sha256 = await sha256Paged(file.path, signal);
    observed.push({ path: file.path, ...(sha256 === undefined ? {} : { sha256 }), access: 'write' });
  }
  return observed;
};
