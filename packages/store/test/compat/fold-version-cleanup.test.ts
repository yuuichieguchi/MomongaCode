import { describe, expect, it } from 'vitest';
import { FIDELITY_FOLD_VERSION } from '@momonga/protocol';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, enqueue, harness, newSession, openStoreAt } from '../helpers.ts';
import { foldVersions, insertVerdict } from './fold-version-fixture.ts';

describe('the fold_version rows at open (H7, 11.6, 20.37)', () => {
  it('keeps every row at open, whatever its fold version', async () => {
    const { dbPath, store } = harness();
    const run = await enqueue(store, newSession(store).id, 'task');
    insertVerdict(dbPath, run.id, FIDELITY_FOLD_VERSION - 1, 'make deploy');
    insertVerdict(dbPath, run.id, FIDELITY_FOLD_VERSION, 'make deploy');
    insertVerdict(dbPath, run.id, FIDELITY_FOLD_VERSION + 1, 'make deploy');
    store.close();
    openStoreAt(dbPath, createFakeClock(START_MS + 10));
    expect(foldVersions(dbPath)).toEqual([FIDELITY_FOLD_VERSION - 1, FIDELITY_FOLD_VERSION, FIDELITY_FOLD_VERSION + 1]);
  });
});
