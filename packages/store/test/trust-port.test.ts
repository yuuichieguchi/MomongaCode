import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeFileSystem, systemRandom } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';
import { openRuntimeStore } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';
import { LEASE_MS, START_MS, UNASKED_COMMANDS, makeStoreDir, rawDb, registerCleanup } from './helpers.ts';

const never = new AbortController().signal;

type Opened = { store: RuntimeStore; dbPath: string; root: string; calls: string[] };

const openWith = (overrides: (root: string) => Partial<FileSystem>): Opened => {
  const root = fs.realpathSync(makeStoreDir());
  const dbPath = path.join(root, 'runtime.db');
  const calls: string[] = [];
  const base = { ...nodeFileSystem, ...overrides(root) };
  const fileSystem = new Proxy(base, {
    get: (target, name, receiver) => {
      const member: unknown = Reflect.get(target, name, receiver);
      if (typeof member !== 'function' || typeof name !== 'string') return member;
      return (...args: unknown[]): unknown => {
        calls.push(name);
        return Reflect.apply(member, target, args);
      };
    },
  });
  const store = openRuntimeStore({ unaskedCommands: UNASKED_COMMANDS, path: dbPath, home: root, clock: createFakeClock(START_MS), leaseMs: LEASE_MS, maxAttempts: 5, maxTotalAttempts: 1000, fileSystem, random: systemRandom });
  registerCleanup(() => store.close());
  return { store, dbPath, root, calls };
};

const storedPaths = (dbPath: string): unknown[] => rawDb(dbPath).prepare('SELECT path FROM trust ORDER BY path').all().map((row) => row['path']);

describe('the trust store resolves paths only through the file-system port it is given', () => {
  it('has only the asked forms', () => {
    const { store } = openWith(() => ({}));
    expect(Object.keys(store.trust).sort()).toEqual(['clearAsked', 'decisionAsked', 'setAsked']);
  });

  it('stores a decision under the path the port resolves, and reads it back through the port', async () => {
    const { store, dbPath, root, calls } = openWith((dir) => ({
      realpath: async (file) => (file === path.join(dir, 'written') ? path.join(dir, 'resolved') : nodeFileSystem.realpath(file)),
    }));
    fs.mkdirSync(path.join(root, 'resolved'));

    await store.trust.setAsked(path.join(root, 'written'), 'trusted', never);

    expect(storedPaths(dbPath)).toEqual([path.join(root, 'resolved')]);
    expect(calls).toContain('realpath');
    expect(await store.trust.decisionAsked(path.join(root, 'written'), never)).toEqual({ decision: 'trusted' });
  });

  it('clears the decision of the path the port resolves', async () => {
    const { store, dbPath, root, calls } = openWith((dir) => ({
      realpath: async (file) => (file === path.join(dir, 'written') ? path.join(dir, 'resolved') : nodeFileSystem.realpath(file)),
      access: async (file, check) => (file === path.join(dir, 'written') ? undefined : nodeFileSystem.access(file, check)),
    }));
    fs.mkdirSync(path.join(root, 'resolved'));
    await store.trust.setAsked(path.join(root, 'resolved'), 'trusted', never);
    calls.length = 0;

    await store.trust.clearAsked(path.join(root, 'written'), never);

    expect(storedPaths(dbPath)).toEqual([]);
    expect(calls).toEqual(expect.arrayContaining(['access', 'realpath']));
  });

  it('clears the decision of a path the port reports as absent by its written form', async () => {
    const { store, dbPath, root } = openWith((dir) => ({
      access: async (file, check) => {
        if (file === path.join(dir, 'gone')) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
        return nodeFileSystem.access(file, check);
      },
    }));
    fs.mkdirSync(path.join(root, 'gone'));
    await store.trust.setAsked(path.join(root, 'gone'), 'trusted', never);

    await store.trust.clearAsked(path.join(root, 'gone'), never);

    expect(storedPaths(dbPath)).toEqual([]);
  });
});
