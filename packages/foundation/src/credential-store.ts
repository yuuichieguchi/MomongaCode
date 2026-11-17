import { createHash } from 'node:crypto';
import path from 'node:path';
import { writeFileAtomically } from './atomic-file.ts';
import { nodeFileSystem } from './node-file-system.ts';
import { acquireFileLock, createKeyedSerializer, systemFileLockPorts } from './file-lock.ts';
import type { FileLockPorts } from './file-lock.ts';
import type { HeldKernelLock, KernelLockMechanism } from './platform/kernel-lock.ts';

export interface CredentialEntry {
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}

export interface CredentialStore {
  read(key: string, signal: AbortSignal): Promise<string | undefined>;
  write(key: string, value: string, signal: AbortSignal): Promise<void>;
  update(key: string, change: (current: string | undefined) => string, signal: AbortSignal): Promise<void>;
  remove(key: string, signal: AbortSignal): Promise<void>;
  withKey<T>(key: string, action: (entry: CredentialEntry) => Promise<T>, signal: AbortSignal, holdsAfter?: HoldsAfter): Promise<T>;
}

export type HoldsAfter = () => boolean;

export type CredentialKeyListing = { keys: { key: string; file: string }[]; problems: { file: string; cause: string }[] };

export interface ListableCredentialStore extends CredentialStore {
  listKeys(signal: AbortSignal): Promise<CredentialKeyListing>;
}

export const AUTH_DOCUMENT_MAX_BYTES = 256 * 1024;

export type ScopedOperations = {
  read(key: string, signal: AbortSignal): Promise<string | undefined>;
  withKey<T>(key: string, action: (entry: CredentialEntry) => Promise<T>, signal: AbortSignal, holdsAfter?: HoldsAfter): Promise<T>;
};

export const storeThroughScope = ({ read, withKey }: ScopedOperations): CredentialStore => ({
  read,
  withKey,
  write: (key, value, signal) => withKey(key, (entry) => entry.write(value), signal),
  update: (key, change, signal) => withKey(key, async (entry) => entry.write(change(await entry.read())), signal),
  remove: (key, signal) => withKey(key, (entry) => entry.remove(), signal),
});

export const createMemoryCredentialStore = (): ListableCredentialStore => {
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
  return {
    ...storeThroughScope({
      read: (key) => Promise.resolve(entries.get(key)),
      withKey: (key, action, signal) => serialized(key, () => action(entryOf(key)), signal),
    }),
    listKeys: async (signal) => {
      signal.throwIfAborted();
      return { keys: [...entries.keys()].map((key) => ({ key, file: key })), problems: [] };
    },
  };
};

const FILE_MODE = 0o600;

export const credentialFileFor = (directory: string, key: string): string => path.join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);

const readOwnerOnly = (file: string): Promise<string | undefined> => nodeFileSystem.readOwnerOnlyTextFile(file, `credential file ${file}`, AUTH_DOCUMENT_MAX_BYTES);

export type FileCredentialStoreOptions = { lock: KernelLockMechanism; ports?: FileLockPorts; lockTimeoutMs?: number };

export const createFileCredentialStore = (directory: string, options: FileCredentialStoreOptions): CredentialStore => {
  const ports = options.ports ?? systemFileLockPorts;
  const serialized = createKeyedSerializer();

  const writeAtomically = async (key: string, value: string): Promise<void> => {
    await nodeFileSystem.mkdirPrivate(directory);
    await writeFileAtomically(nodeFileSystem, ports.random, credentialFileFor(directory, key), value, { mode: FILE_MODE, lock: options.lock });
  };

  const held = new Map<string, HeldKernelLock>();

  const crossProcessLock = async (key: string, signal: AbortSignal): Promise<HeldKernelLock> => {
    const kept = held.get(key);
    if (kept !== undefined) return kept;
    const lockDirectory = `${directory}.locks`;
    await nodeFileSystem.mkdirPrivate(lockDirectory);
    const lockPath = path.join(lockDirectory, `${path.basename(credentialFileFor(directory, key))}.lock`);
    return acquireFileLock(lockPath, { ports, mechanism: options.lock, signal, ...(options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }) });
  };

  const locked = <T>(key: string, action: () => Promise<T>, signal: AbortSignal, holdsAfter: HoldsAfter | undefined): Promise<T> =>
    serialized(
      key,
      async () => {
        const lock = await crossProcessLock(key, signal);
        try {
          return await action();
        } finally {
          if (holdsAfter?.() === true) {
            held.set(key, lock);
          } else {
            held.delete(key);
            lock.release();
          }
        }
      },
      signal,
    );

  const entryOf = (key: string): CredentialEntry => ({
    read: () => readOwnerOnly(credentialFileFor(directory, key)),
    write: (value) => writeAtomically(key, value),
    remove: () => nodeFileSystem.rm(credentialFileFor(directory, key)),
  });

  return storeThroughScope({
    read: (key) => readOwnerOnly(credentialFileFor(directory, key)),
    withKey: (key, action, signal, holdsAfter) => locked(key, () => action(entryOf(key)), signal, holdsAfter),
  });
};
