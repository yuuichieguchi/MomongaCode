import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StoreIdentityError, isFatalStoreError } from '@momonga/store';
import { harness, newSession } from './helpers.ts';

const thrownBy = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected the action to throw');
};

describe('RuntimeStore.checkIdentity', () => {
  it('does not throw while the database path is unchanged', () => {
    const { store } = harness();
    newSession(store);

    expect(() => store.checkIdentity()).not.toThrow();
  });

  it('throws StoreIdentityError after runtime.db is renamed', () => {
    const { dbPath, dir, store } = harness();
    fs.renameSync(dbPath, path.join(dir, 'moved.db'));

    expect(thrownBy(() => store.checkIdentity())).toBeInstanceOf(StoreIdentityError);
  });

  it('throws StoreIdentityError after runtime.db is unlinked', () => {
    const { dbPath, store } = harness();
    fs.unlinkSync(dbPath);

    expect(thrownBy(() => store.checkIdentity())).toBeInstanceOf(StoreIdentityError);
  });

  it('throws StoreIdentityError when a different file replaces runtime.db', () => {
    const { dbPath, dir, store } = harness();
    const replacement = path.join(dir, 'replacement.db');
    fs.writeFileSync(replacement, '', { mode: 0o600 });
    fs.renameSync(replacement, dbPath);

    expect(thrownBy(() => store.checkIdentity())).toBeInstanceOf(StoreIdentityError);
  });

  it('isFatalStoreError recognises StoreIdentityError', () => {
    const { dbPath, store } = harness();
    fs.unlinkSync(dbPath);

    const error = thrownBy(() => store.checkIdentity());

    expect(error).toBeInstanceOf(StoreIdentityError);
    expect(isFatalStoreError(error)).toBe(true);
  });
});
