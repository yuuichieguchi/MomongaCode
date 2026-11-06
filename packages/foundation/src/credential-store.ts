import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomically } from './atomic-file.ts';
import { createKeyedSerializer, systemFileLockPorts, withFileLock } from './file-lock.ts';
import type { FileLockPorts } from './file-lock.ts';
import { assertPrivateRegularFile, noFollowFlag } from './platform/privacy.ts';

export interface CredentialStore {
  read(key: string): Promise<string | undefined>;
  write(key: string, value: string): Promise<void>;
  update(key: string, change: (current: string | undefined) => string): Promise<void>;
  remove(key: string): Promise<void>;
}

export const createMemoryCredentialStore = (): CredentialStore => {
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

export type FileCredentialStoreOptions = { ports?: FileLockPorts; lockTimeoutMs?: number };

export const createFileCredentialStore = (directory: string, options: FileCredentialStoreOptions = {}): CredentialStore => {
  const ports = options.ports ?? systemFileLockPorts;
  const serialized = createKeyedSerializer();

  const ensureDirectory = async (): Promise<void> => {
    await fs.promises.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await fs.promises.chmod(directory, DIRECTORY_MODE);
  };

  const writeAtomically = async (key: string, value: string): Promise<void> => {
    await ensureDirectory();
    await writeFileAtomically(fileFor(directory, key), value, { mode: FILE_MODE, randomHex: ports.randomHex });
  };

  const locked = <T>(key: string, action: () => Promise<T>): Promise<T> =>
    serialized(key, async () => {
      const lockDirectory = `${directory}.locks`;
      await fs.promises.mkdir(lockDirectory, { recursive: true, mode: DIRECTORY_MODE });
      const lockPath = path.join(lockDirectory, `${path.basename(fileFor(directory, key))}.lock`);
      return withFileLock(lockPath, action, { ports, ...(options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }) });
    });

  return {
    read: (key) => readOwnerOnly(fileFor(directory, key)),
    write: (key, value) => locked(key, () => writeAtomically(key, value)),
    update: (key, change) => locked(key, async () => writeAtomically(key, change(await readOwnerOnly(fileFor(directory, key))))),
    remove: (key) => locked(key, () => fs.promises.rm(fileFor(directory, key), { force: true })),
  };
};
