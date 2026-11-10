import { describe, expect, it } from 'vitest';
import { FIDELITY_FOLD_VERSION } from '@momonga/protocol';
import { FIDELITY_PRUNE_BATCH_ROWS } from '@momonga/store';
import { enqueue, harness, newSession } from '../helpers.ts';
import { foldVersions, insertVerdict } from './fold-version-fixture.ts';

const FOLD = FIDELITY_FOLD_VERSION;

describe('pruneFidelityVerdicts(bound) (11.6, 17.5, 20.37)', () => {
  it('removes only the rows below the bound', () => {
    const { dbPath, store } = harness();
    const run = enqueue(store, newSession(store).id, 'task');
    for (const version of [FOLD - 1, FOLD, FOLD + 1]) insertVerdict(dbPath, run.id, version, 'make deploy');
    expect(store.pruneFidelityVerdicts(FOLD - 1)).toBe(0);
    expect(foldVersions(dbPath)).toEqual([FOLD - 1, FOLD, FOLD + 1]);
    expect(store.pruneFidelityVerdicts(FOLD)).toBe(1);
    expect(foldVersions(dbPath)).toEqual([FOLD, FOLD + 1]);
  });

  it('deletes at most one batch of 500 rows per call and reports how many it deleted', () => {
    const { dbPath, store } = harness();
    const run = enqueue(store, newSession(store).id, 'task');
    expect(FIDELITY_PRUNE_BATCH_ROWS).toBe(500);
    for (let index = 0; index < FIDELITY_PRUNE_BATCH_ROWS + 3; index += 1) insertVerdict(dbPath, run.id, FOLD - 1, `token-${index}`);
    insertVerdict(dbPath, run.id, FOLD, 'kept');
    expect(store.pruneFidelityVerdicts(FOLD)).toBe(500);
    expect(foldVersions(dbPath)).toHaveLength(4);
    expect(store.pruneFidelityVerdicts(FOLD)).toBe(3);
    expect(foldVersions(dbPath)).toEqual([FOLD]);
  });
});
