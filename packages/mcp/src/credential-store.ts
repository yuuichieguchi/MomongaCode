import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ProcessLockHeldError, acquireProcessLock, assertPrivateRegularFile, noFollowFlag } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';

const LOCK_RETRY_MS = 25;

export interface McpCredentialStore {
  read(key: string): Promise<string | undefined>;
  write(key: string, value: string): Promise<void>;
  update(key: string, change: (current: string | undefined) => string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const mcpCredentialDirectory = (paths: Pick<MomongaPaths, 'state'>): string => path.join(paths.state, 'mcp-credentials');

export const createMemoryCredentialStore = (): McpCredentialStore => {
  const entries = new Map<string, string>();
  return {
    update: (key, change) => {
      entries.set(key, change(entries.get(key)));
      return Promise.resolve();
    },
    read: (key) => Promise.resolve(entries.get(key)),
    write: (key, value) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    remove: (key) => {
      entries.delete(key);
      return Promise.resolve();
    },
  };
};

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

const fileFor = (directory: string, key: string): string => path.join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);

const readOwnerOnly = async (file: string): Promise<string | undefined> => {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    assertPrivateRegularFile(stat, `credential file ${file}`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await fs.promises.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export type FileCredentialStoreOptions = { sleep?: (ms: number) => Promise<void> };

export const createFileCredentialStore = (directory: string, options: FileCredentialStoreOptions = {}): McpCredentialStore => {
  const sleep = options.sleep ?? realSleep;
  const queues = new Map<string, Promise<unknown>>();

  const ensureDirectory = async (): Promise<void> => {
    await fs.promises.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await fs.promises.chmod(directory, DIRECTORY_MODE);
  };

  const writeAtomically = async (key: string, value: string): Promise<void> => {
    await ensureDirectory();
    const target = fileFor(directory, key);
    const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const handle = await fs.promises.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, FILE_MODE);
      try {
        await handle.writeFile(value, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.promises.rename(temporary, target);
    } catch (error) {
      await fs.promises.rm(temporary, { force: true });
      throw error;
    }
    await syncDirectory(directory);
  };

  const acquire = async (key: string): Promise<{ release(): void }> => {
    const lockPath = `${fileFor(directory, key)}.lock`;
    for (;;) {
      try {
        return await acquireProcessLock(lockPath);
      } catch (error) {
        if (!(error instanceof ProcessLockHeldError)) throw error;
        await sleep(LOCK_RETRY_MS);
      }
    }
  };

  const serialized = <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(action, action);
    queues.set(key, run.catch(() => undefined));
    return run;
  };

  return {
    read: (key) => readOwnerOnly(fileFor(directory, key)),
    write: (key, value) => serialized(key, () => writeAtomically(key, value)),
    update: (key, change) =>
      serialized(key, async () => {
        await ensureDirectory();
        const lock = await acquire(key);
        try {
          await writeAtomically(key, change(await readOwnerOnly(fileFor(directory, key))));
        } finally {
          lock.release();
        }
      }),
    remove: (key) => serialized(key, () => fs.promises.rm(fileFor(directory, key), { force: true })),
  };
};
