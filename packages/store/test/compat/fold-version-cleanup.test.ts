import { describe, expect, it } from 'vitest';
import { FIDELITY_FOLD_VERSION } from '@momonga/protocol';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, enqueue, harness, newSession, openStoreAt, rawDb } from '../helpers.ts';

const insertVerdict = (dbPath: string, runId: string, foldVersion: number): void => {
  rawDb(dbPath)
    .prepare(
      `INSERT INTO fidelity_verdicts (run_id, cwd, fold_version, token, inh, inh_deps, task_stated, stated_at, executed_at, own_deps, checked_through)
       VALUES (?, '/work/a', ?, 'make deploy', 'none', '[]', 0, NULL, NULL, '[]', 0)`,
    )
    .run(runId, foldVersion);
};

const foldVersions = (dbPath: string): number[] =>
  rawDb(dbPath)
    .prepare('SELECT fold_version FROM fidelity_verdicts ORDER BY fold_version')
    .all()
    .map((row) => Number(row['fold_version']));

describe('the fold_version cleanup at open (H7, 11.6)', () => {
  it('keeps the rows of a higher fold version, which a newer generation still uses, and removes the lower ones', () => {
    const { dbPath, store } = harness();
    const run = enqueue(store, newSession(store).id, 'task');
    insertVerdict(dbPath, run.id, FIDELITY_FOLD_VERSION - 1);
    insertVerdict(dbPath, run.id, FIDELITY_FOLD_VERSION);
    insertVerdict(dbPath, run.id, FIDELITY_FOLD_VERSION + 1);
    store.close();
    openStoreAt(dbPath, createFakeClock(START_MS + 10));
    expect(foldVersions(dbPath)).toEqual([FIDELITY_FOLD_VERSION, FIDELITY_FOLD_VERSION + 1]);
  });
});
