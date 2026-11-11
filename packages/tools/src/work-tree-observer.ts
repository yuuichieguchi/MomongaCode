import { createHash } from 'node:crypto';
import path from 'node:path';
import { OPEN_FLAGS } from '@momonga/foundation';
import type { FileSystem, ReadHandle } from '@momonga/foundation';
import type { ToolFile } from '@momonga/protocol';
import type { ChildPorts } from './ports.ts';

export type WorkTreeMark = { readonly tree: string };

export type ObservedFile = { path: string; change: 'write' | 'remove' };

export type ObservedWindow = { files: ObservedFile[]; mark: WorkTreeMark };

export type WorkTreeObserver = {
  mark(signal: AbortSignal): Promise<WorkTreeMark | undefined>;
  changedSince(mark: WorkTreeMark, signal: AbortSignal): Promise<ObservedWindow | undefined>;
};

export type GitWorkTreeObserverOptions = { storeDir: string; workTree: string; trusted: boolean };

export type WorkTreeObserverPorts = {
  child: Pick<ChildPorts, 'spawn'>;
  files: Pick<FileSystem, 'stat' | 'mkdir'>;
  searchPath: string | undefined;
  processId: number;
};

export const OBSERVED_FILE_HASH_PAGE_BYTES = 1024 * 1024;

const GIT_DIRECTORY_ENTRY = '.git';
const STORE_DIRECTORY_MODE = 0o700;
const TREE_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LANG: 'C' } as const;

let observersCreated = 0;

type GitRun = (args: readonly string[], signal: AbortSignal) => Promise<Buffer | undefined>;

const gitRunOn =
  (child: Pick<ChildPorts, 'spawn'>, env: Readonly<Record<string, string>>): GitRun =>
  (args, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve(undefined);
        return;
      }
      const chunks: Buffer[] = [];
      const started = child.spawn('git', args, { env, signal });
      started.stderr?.resume();
      started.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
      started.on('error', () => resolve(undefined));
      started.on('close', (code: number | null) => resolve(code === 0 ? Buffer.concat(chunks) : undefined));
    });

const exists = async (files: Pick<FileSystem, 'stat'>, entry: string): Promise<boolean> => {
  try {
    await files.stat(entry);
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

export const workTreeObserverOn = (ports: WorkTreeObserverPorts, { storeDir, workTree, trusted }: GitWorkTreeObserverOptions): WorkTreeObserver => {
  observersCreated += 1;
  const indexFile = path.join(storeDir, `index-${ports.processId}-${observersCreated}`);
  const runGit = gitRunOn(ports.child, {
    ...(ports.searchPath === undefined ? {} : { PATH: ports.searchPath }),
    ...GIT_ENV,
    GIT_DIR: storeDir,
    GIT_WORK_TREE: workTree,
    GIT_INDEX_FILE: indexFile,
  });
  let initialised: Promise<boolean> | undefined;

  const ready = (signal: AbortSignal): Promise<boolean> => {
    initialised ??= (async () => {
      if (!trusted || !(await exists(ports.files, path.join(workTree, GIT_DIRECTORY_ENTRY)))) return false;
      if (await exists(ports.files, path.join(storeDir, 'HEAD'))) return true;
      await ports.files.mkdir(storeDir, STORE_DIRECTORY_MODE);
      return (await runGit(['init', '-q'], signal)) !== undefined;
    })();
    return initialised;
  };

  const snapshot = async (signal: AbortSignal): Promise<WorkTreeMark | undefined> => {
    if (!(await ready(signal))) return undefined;
    if ((await runGit(['add', '-A', '--', '.'], signal)) === undefined) return undefined;
    const written = await runGit(['write-tree'], signal);
    const tree = written?.toString('utf8').trim();
    return tree === undefined || !TREE_ID.test(tree) ? undefined : { tree };
  };

  return {
    mark: snapshot,
    changedSince: async (mark, signal) => {
      const closing = await snapshot(signal);
      if (closing === undefined) return undefined;
      const diff = await runGit(['diff-tree', '-r', '--name-status', '-z', '--no-renames', mark.tree, closing.tree], signal);
      return diff === undefined ? undefined : { files: changesOf(workTree, diff.toString('utf8')), mark: closing };
    },
  };
};

const sha256Paged = async (files: Pick<FileSystem, 'openRead'>, file: string, signal: AbortSignal): Promise<string | undefined> => {
  let handle: ReadHandle;
  try {
    handle = await files.openRead(file, OPEN_FLAGS.readOnly | OPEN_FLAGS.noFollow | OPEN_FLAGS.nonBlocking);
  } catch {
    return undefined;
  }
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    const hash = createHash('sha256');
    const page = Buffer.alloc(OBSERVED_FILE_HASH_PAGE_BYTES);
    for (;;) {
      if (signal.aborted) return undefined;
      const bytesRead = await handle.read(page);
      if (bytesRead === 0) return hash.digest('hex');
      hash.update(page.subarray(0, bytesRead));
    }
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
};

export const observedToolFiles = async (reader: Pick<FileSystem, 'openRead'>, files: readonly ObservedFile[], signal: AbortSignal): Promise<ToolFile[]> => {
  const observed: ToolFile[] = [];
  for (const file of files) {
    if (file.change === 'remove') {
      observed.push({ path: file.path, access: 'remove' });
      continue;
    }
    const sha256 = await sha256Paged(reader, file.path, signal);
    observed.push({ path: file.path, ...(sha256 === undefined ? {} : { sha256 }), access: 'write' });
  }
  return observed;
};
