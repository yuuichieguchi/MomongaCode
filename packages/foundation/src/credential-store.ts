import { createHash } from 'node:crypto';
import path from 'node:path';
import { writeFileAtomically } from './atomic-file.ts';
import { nodeFileSystem } from './node-file-system.ts';
import { systemRandom } from './system-random.ts';
import { createKeyedSerializer, systemFileLockPorts, withFileLock } from './file-lock.ts';
import type { FileLockPorts } from './file-lock.ts';

export interface CredentialEntry {
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}

export interface CredentialStore {
  read(key: string): Promise<string | undefined>;
  write(key: string, value: string): Promise<void>;
  update(key: string, change: (current: string | undefined) => string): Promise<void>;
  remove(key: string): Promise<void>;
  withKey<T>(key: string, action: (entry: CredentialEntry) => Promise<T>): Promise<T>;
}

type ScopedOperations = {
  read(key: string): Promise<string | undefined>;
  withKey<T>(key: string, action: (entry: CredentialEntry) => Promise<T>): Promise<T>;
};

const storeThroughScope = ({ read, withKey }: ScopedOperations): CredentialStore => ({
  read,
  withKey,
  write: (key, value) => withKey(key, (entry) => entry.write(value)),
  update: (key, change) => withKey(key, async (entry) => entry.write(change(await entry.read()))),
  remove: (key) => withKey(key, (entry) => entry.remove()),
});

export const createMemoryCredentialStore = (): CredentialStore => {
  const entries = new Map<string, string>();
  const serialized = createKeyedSerializer();
  const entryOf = (key: string): CredentialEntry => ({
    read: () => Promise.resolve(entries.get(key)),
    write: (value) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    remove: () => {
      entries.delete(key);
      return Promise.resolve();
    },
  });
  return storeThroughScope({
    read: (key) => Promise.resolve(entries.get(key)),
    withKey: (key, action) => serialized(key, () => action(entryOf(key))),
  });
};

const FILE_MODE = 0o600;

const fileFor = (directory: string, key: string): string => path.join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);

const readOwnerOnly = (file: string): Promise<string | undefined> => nodeFileSystem.readOwnerOnlyTextFile(file, `credential file ${file}`);

export type FileCredentialStoreOptions = { ports?: FileLockPorts; lockTimeoutMs?: number };

export const createFileCredentialStore = (directory: string, options: FileCredentialStoreOptions = {}): CredentialStore => {
  const ports = options.ports ?? systemFileLockPorts;
  const serialized = createKeyedSerializer();

  const writeAtomically = async (key: string, value: string): Promise<void> => {
    await nodeFileSystem.mkdirPrivate(directory);
    await writeFileAtomically(nodeFileSystem, { ...systemRandom, hex: ports.randomHex }, fileFor(directory, key), value, { mode: FILE_MODE });
  };

  const locked = <T>(key: string, action: () => Promise<T>): Promise<T> =>
    serialized(key, async () => {
      const lockDirectory = `${directory}.locks`;
      await nodeFileSystem.mkdirPrivate(lockDirectory);
      const lockPath = path.join(lockDirectory, `${path.basename(fileFor(directory, key))}.lock`);
      return withFileLock(lockPath, action, { ports, ...(options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }) });
    });

  const entryOf = (key: string): CredentialEntry => ({
    read: () => readOwnerOnly(fileFor(directory, key)),
    write: (value) => writeAtomically(key, value),
    remove: () => nodeFileSystem.rm(fileFor(directory, key)),
  });

  return storeThroughScope({
    read: (key) => readOwnerOnly(fileFor(directory, key)),
    withKey: (key, action) => locked(key, () => action(entryOf(key))),
  });
};
