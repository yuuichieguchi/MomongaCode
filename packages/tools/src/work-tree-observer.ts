import { createHash } from 'node:crypto';
import path from 'node:path';
import { OPEN_FLAGS, sha256Hex } from '@momonga/foundation';
import type { FileSystem, ReadHandle } from '@momonga/foundation';
import type { ToolFile } from '@momonga/protocol';
import type { ChildLaunch, ChildPorts } from './ports.ts';

export type WorkTreeMark = { readonly tree: string; readonly oversized: readonly string[] };

export type ObservedFile = { path: string; change: 'write' | 'remove' };

export type ObservedWindow = { files: ObservedFile[]; mark: WorkTreeMark; oversized: string[] };

export type WorkTreeObserver = {
  mark(signal: AbortSignal): Promise<WorkTreeMark | undefined>;
  changedSince(mark: WorkTreeMark, signal: AbortSignal): Promise<ObservedWindow>;
};

export class WorkTreeObservationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'WorkTreeObservationError';
  }
}

export type GitWorkTreeObserverOptions = { storeRoot: string; cwd: string; trusted: boolean };

export type WorkTreeObserverPorts = {
  child: Pick<ChildPorts, 'spawn'>;
  files: Pick<FileSystem, 'stat' | 'lstat' | 'mkdir' | 'readdir'>;
  searchPath: string | undefined;
  processId: number;
  launch: ChildLaunch;
};

export const OBSERVED_FILE_HASH_PAGE_BYTES = 1024 * 1024;

export const OBSERVED_UNTRACKED_FILE_MAX_BYTES = 2 * OBSERVED_FILE_HASH_PAGE_BYTES;

export const observerStoreOf = (storeRoot: string, repositoryRoot: string): string => path.join(storeRoot, sha256Hex(repositoryRoot));

const GIT_DIRECTORY_ENTRY = '.git';
const STORE_DIRECTORY_MODE = 0o700;
const TREE_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const ABSENT_CODES: readonly string[] = ['ENOENT', 'ENOTDIR'];

const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LANG: 'C' } as const;

let observersCreated = 0;

type GitRun = (args: readonly string[], signal: AbortSignal) => Promise<Buffer>;

const gitRunOn =
  (child: Pick<ChildPorts, 'spawn'>, launch: ChildLaunch, store: string, cwd: string, env: Readonly<Record<string, string>>): GitRun =>
  (args, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new WorkTreeObservationError(`git ${args[0]} was stopped before it started`));
        return;
      }
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];
      const launched = launch.commandOf(['git', ...args], [store]);
      const started = child.spawn(launched.file, launched.args, { cwd, env, signal });
      started.stderr?.on('data', (chunk: Buffer) => errors.push(chunk));
      started.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
      started.on('error', (error: Error) => reject(new WorkTreeObservationError(`git ${args[0]} could not run: ${error.message}`)));
      started.on('close', (code: number | null) => {
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new WorkTreeObservationError(`git ${args[0]} exited with ${code === null ? 'a signal' : code}: ${Buffer.concat(errors).toString('utf8').trim()}`));
      });
    });

const exists = async (files: Pick<FileSystem, 'lstat'>, entry: string): Promise<boolean> => {
  try {
    await files.lstat(entry);
    return true;
  } catch (error) {
    if (ABSENT_CODES.includes(String((error as NodeJS.ErrnoException).code))) return false;
    throw new WorkTreeObservationError(`${entry} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const repositoryRootOf = async (files: Pick<FileSystem, 'lstat'>, cwd: string): Promise<string | undefined> => {
  for (let folder = path.resolve(cwd); ; folder = path.dirname(folder)) {
    if (await exists(files, path.join(folder, GIT_DIRECTORY_ENTRY))) return folder;
    if (path.dirname(folder) === folder) return undefined;
  }
};

const fieldsOf = (output: Buffer): string[] => output.toString('utf8').split('\0').filter((field) => field !== '');

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

type Store = { workTree: string; runGit: GitRun };

export const workTreeObserverOn = (ports: WorkTreeObserverPorts, { storeRoot, cwd, trusted }: GitWorkTreeObserverOptions): WorkTreeObserver => {
  observersCreated += 1;
  const observerNumber = observersCreated;
  let opened: Promise<Store | undefined> | undefined;

  const open = async (signal: AbortSignal): Promise<Store | undefined> => {
    if (!trusted) return undefined;
    const workTree = await repositoryRootOf(ports.files, cwd);
    if (workTree === undefined) return undefined;
    const storeDir = observerStoreOf(storeRoot, workTree);
    const runGit = gitRunOn(ports.child, ports.launch, storeDir, workTree, {
      ...(ports.searchPath === undefined ? {} : { PATH: ports.searchPath }),
      ...GIT_ENV,
      GIT_DIR: storeDir,
      GIT_WORK_TREE: workTree,
      GIT_INDEX_FILE: path.join(storeDir, `index-${ports.processId}-${observerNumber}`),
    });
    if (!(await exists(ports.files, path.join(storeDir, 'HEAD')))) {
      await ports.files.mkdir(storeDir, STORE_DIRECTORY_MODE);
      await runGit(['init', '-q'], signal);
    }
    return { workTree, runGit };
  };

  const oversizedOf = async (store: Store, signal: AbortSignal): Promise<string[]> => {
    const untracked = fieldsOf(await store.runGit(['ls-files', '--others', '--exclude-standard', '-z'], signal));
    const oversized: string[] = [];
    for (const relative of untracked) {
      const file = path.join(store.workTree, relative);
      if ((await ports.files.lstat(file)).size > OBSERVED_UNTRACKED_FILE_MAX_BYTES) oversized.push(relative);
    }
    return oversized;
  };

  const snapshot = async (store: Store, signal: AbortSignal): Promise<WorkTreeMark> => {
    const oversized = await oversizedOf(store, signal);
    await store.runGit(['add', '-A', '--', '.', ...oversized.map((relative) => `:(exclude,literal)${relative}`)], signal);
    const tree = (await store.runGit(['write-tree'], signal)).toString('utf8').trim();
    if (!TREE_ID.test(tree)) throw new WorkTreeObservationError(`git write-tree answered ${JSON.stringify(tree)}, which is not a tree id`);
    return { tree, oversized: oversized.map((relative) => path.join(store.workTree, relative)) };
  };

  const storeOf = (signal: AbortSignal): Promise<Store | undefined> => {
    opened ??= open(signal).catch((error: unknown) => {
      opened = undefined;
      throw error;
    });
    return opened;
  };

  return {
    mark: async (signal) => {
      const store = await storeOf(signal);
      return store === undefined ? undefined : snapshot(store, signal);
    },
    changedSince: async (mark, signal) => {
      const store = await storeOf(signal);
      if (store === undefined) throw new WorkTreeObservationError('the folder has no repository to observe');
      const closing = await snapshot(store, signal);
      const diff = await store.runGit(['diff-tree', '-r', '--name-status', '-z', '--no-renames', mark.tree, closing.tree], signal);
      const before = new Set(mark.oversized);
      return { files: changesOf(store.workTree, diff.toString('utf8')), mark: closing, oversized: closing.oversized.filter((file) => !before.has(file)) };
    },
  };
};

export type ObserverStorePrune = { storeRoot: string; cutoffMs: number };

const MS_PER_SECOND = 1000;

export const pruneObserverStores = async (ports: Omit<WorkTreeObserverPorts, 'processId'>, { storeRoot, cutoffMs }: ObserverStorePrune, signal: AbortSignal): Promise<void> => {
  if (!(await exists(ports.files, storeRoot))) return;
  const expire = `--expire=@${Math.floor(cutoffMs / MS_PER_SECOND)}`;
  for (const name of await ports.files.readdir(storeRoot)) {
    const storeDir = path.join(storeRoot, name);
    if (!(await exists(ports.files, path.join(storeDir, 'HEAD')))) continue;
    const runGit = gitRunOn(ports.child, ports.launch, storeDir, storeRoot, { ...(ports.searchPath === undefined ? {} : { PATH: ports.searchPath }), ...GIT_ENV, GIT_DIR: storeDir });
    await runGit(['prune', expire], signal);
  }
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
