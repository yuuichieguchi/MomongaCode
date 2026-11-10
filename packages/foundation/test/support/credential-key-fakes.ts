import { createHash } from 'node:crypto';
import path from 'node:path';
import * as foundation from '@momonga/foundation';
import type { FileLockPorts, SecretStore } from '@momonga/foundation';
import type { SecretBackend } from '@momonga/foundation/secret-store';

export const FAKE_KEY_STORE_ADVICE = 'the fake key store may be waiting for an answer';

export const FAKE_KEY_STORE_BACKEND: SecretBackend = {
  label: 'Fake Key Store',
  searchedProgram: 'fake-key-store',
  childEnvNames: [],
  storeCommand: (secretName) => `fake-key-store add ${secretName}`,
  unansweredAdvice: FAKE_KEY_STORE_ADVICE,
  readiness: undefined,
};

export type FakeKeyStore = SecretStore & {
  readonly items: Map<string, string>;
  readonly reads: string[];
  readonly writes: string[];
  readonly hung: Array<{ action: 'read' | 'write'; name: string }>;
  hang: boolean;
  onWrite?: (name: string) => void;
};

export const createFakeKeyStore = (initial: Readonly<Record<string, string>> = {}): FakeKeyStore => {
  const items = new Map(Object.entries(initial));
  const reads: string[] = [];
  const writes: string[] = [];
  const hung: FakeKeyStore['hung'] = [];
  const neverAnswered = <T>(action: 'read' | 'write', name: string, signal: AbortSignal): Promise<T> =>
    new Promise<T>((_resolve, reject) => {
      const end = (): void => {
        try {
          reject(foundation.endedStoreCall({ action, name, backend: FAKE_KEY_STORE_BACKEND }, signal.reason));
        } catch (error) {
          reject(error);
        }
      };
      hung.push({ action, name });
      if (signal.aborted) end();
      else signal.addEventListener('abort', end, { once: true });
    });
  const store: FakeKeyStore = {
    items,
    reads,
    writes,
    hung,
    hang: false,
    read: async (name, signal) => {
      reads.push(name);
      if (store.hang) return neverAnswered<string>('read', name, signal);
      const value = items.get(name);
      if (value === undefined) throw new Error(`the fake key store has no item ${name}`);
      return value;
    },
    write: async (name, value, signal) => {
      store.onWrite?.(name);
      writes.push(name);
      items.set(name, value);
      if (store.hang) return neverAnswered<void>('write', name, signal);
    },
  };
  return store;
};

export const recordFileOf = (directory: string, key: string): string => path.join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);

export const recordLockOf = (directory: string, key: string): string => path.join(`${directory}.locks`, `${path.basename(recordFileOf(directory, key))}.lock`);

export type SteppedPorts = FileLockPorts & { waitedMs(): number };

export const steppedPorts = (): SteppedPorts => {
  const start = 1_000_000;
  let now = start;
  return {
    clock: { now: () => now },
    sleep: (ms) => {
      now += ms;
      return new Promise((resolve) => setImmediate(resolve));
    },
    randomHex: () => 'cafe0001',
    waitedMs: () => now - start,
  };
};
