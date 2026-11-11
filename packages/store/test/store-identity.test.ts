import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeFileSystem, systemRandom } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';
import { StoreIdentityError, isFatalStoreError, openRuntimeStore } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';
import { LEASE_MS, START_MS, UNASKED_COMMANDS, harness, makeStoreDir, newSession, registerCleanup } from './helpers.ts';

const thrownBy = async (action: () => Promise<unknown>): Promise<unknown> => {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('expected the action to throw');
};

const storeWhoseStatFails = (failure: unknown): RuntimeStore => {
  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  const fileSystem: FileSystem = {
    ...nodeFileSystem,
    stat: async (file) => {
      if (file === dbPath) throw failure;
      return nodeFileSystem.stat(file);
    },
  };
  const store = openRuntimeStore({ fileSystem, random: systemRandom, unaskedCommands: UNASKED_COMMANDS, path: dbPath, home: path.dirname(dbPath), clock: createFakeClock(START_MS), leaseMs: LEASE_MS, maxAttempts: 5, maxTotalAttempts: 1000 });
  registerCleanup(() => store.close());
  return store;
};

describe('RuntimeStore.checkIdentity', () => {
  it('does not throw while the database path is unchanged', async () => {
    const { store } = harness();
    newSession(store);

    await store.checkIdentity();
  });

  it('throws StoreIdentityError after runtime.db is renamed', async () => {
    const { dbPath, dir, store } = harness();
    fs.renameSync(dbPath, path.join(dir, 'moved.db'));

    expect(await thrownBy(() => store.checkIdentity())).toBeInstanceOf(StoreIdentityError);
  });

  it('throws StoreIdentityError after runtime.db is unlinked', async () => {
    const { dbPath, store } = harness();
    fs.unlinkSync(dbPath);

    expect(await thrownBy(() => store.checkIdentity())).toBeInstanceOf(StoreIdentityError);
  });

  it('throws StoreIdentityError when a different file replaces runtime.db right after the open', async () => {
    const { dbPath, dir, store } = harness();
    const replacement = path.join(dir, 'replacement.db');
    fs.writeFileSync(replacement, '', { mode: 0o600 });
    fs.renameSync(replacement, dbPath);

    expect(await thrownBy(() => store.checkIdentity())).toBeInstanceOf(StoreIdentityError);
  });

  it('isFatalStoreError recognises StoreIdentityError', async () => {
    const { dbPath, store } = harness();
    fs.unlinkSync(dbPath);

    const error = await thrownBy(() => store.checkIdentity());

    expect(error).toBeInstanceOf(StoreIdentityError);
    expect(isFatalStoreError(error)).toBe(true);
  });

  it.each(['EMFILE', 'EIO', 'ENOSPC'])('rethrows a transient %s from the stat of the port unchanged instead of a StoreIdentityError', async (code) => {
    const failure = Object.assign(new Error(`${code}: injected`), { code });
    const store = storeWhoseStatFails(failure);

    const error = await thrownBy(() => store.checkIdentity());

    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(StoreIdentityError);
  });

  it('an ENOENT from the stat of the port is still a StoreIdentityError', async () => {
    const failure = Object.assign(new Error('ENOENT: injected'), { code: 'ENOENT' });
    const store = storeWhoseStatFails(failure);

    const error = await thrownBy(() => store.checkIdentity());

    expect(error).toBeInstanceOf(StoreIdentityError);
    expect((error as Error).cause).toBe(failure);
  });
});
