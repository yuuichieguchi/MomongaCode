import { describe, expect, it } from 'vitest';
import { harness, newSession, openStoreAt } from './helpers.ts';

describe('store dataVersion', () => {
  it('changes when another connection commits and not when its own connection commits', () => {
    const { store, dbPath, clock } = harness();
    const before = store.dataVersion();
    newSession(store);
    expect(store.dataVersion()).toBe(before);

    const other = openStoreAt(dbPath, clock, {});
    newSession(other, '/work/b');
    expect(store.dataVersion()).not.toBe(before);

    const after = store.dataVersion();
    newSession(store);
    expect(store.dataVersion()).toBe(after);
  });
});
