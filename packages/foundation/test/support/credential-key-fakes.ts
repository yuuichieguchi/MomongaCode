import { createHash } from 'node:crypto';
import path from 'node:path';
import type { FileLockPorts, SecretStore } from '@momonga/foundation';

export type FakeKeyStore = SecretStore & {
  readonly items: Map<string, string>;
  readonly reads: string[];
  readonly writes: string[];
  onWrite?: (name: string) => void;
};

export const createFakeKeyStore = (initial: Readonly<Record<string, string>> = {}): FakeKeyStore => {
  const items = new Map(Object.entries(initial));
  const reads: string[] = [];
  const writes: string[] = [];
  const store: FakeKeyStore = {
    items,
    reads,
    writes,
    read: async (name) => {
      reads.push(name);
      const value = items.get(name);
      if (value === undefined) throw new Error(`the fake key store has no item ${name}`);
      return value;
    },
    write: async (name, value) => {
      store.onWrite?.(name);
      writes.push(name);
      items.set(name, value);
    },
  };
  return store;
};

export const recordFileOf = (directory: string, key: string): string => path.join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);

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
