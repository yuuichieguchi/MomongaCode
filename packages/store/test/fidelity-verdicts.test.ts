import { describe, expect, it } from 'vitest';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, enqueue, harness, newSession, openStoreAt, rawDb } from './helpers.ts';

const KEY = ['run_id', 'cwd', 'fold_version', 'token'];

const COLUMNS = [...KEY, 'inh', 'inh_deps', 'task_stated', 'stated_at', 'executed_at', 'own_deps', 'checked_through'];

const withRun = () => {
  const env = harness();
  const session = newSession(env.store);
  const run = enqueue(env.store, session.id, 'task');
  return { ...env, session, run };
};

const insertVerdict = (dbPath: string, runId: string, foldVersion: number): void => {
  rawDb(dbPath)
    .prepare(
      `INSERT INTO fidelity_verdicts (run_id, cwd, fold_version, token, inh, inh_deps, task_stated, stated_at, executed_at, own_deps, checked_through)
       VALUES (?, '/work/a', ?, 'make deploy', 'none', '[]', 0, NULL, NULL, '[]', 0)`,
    )
    .run(runId, foldVersion);
};

const verdictCount = (dbPath: string): number => Number(rawDb(dbPath).prepare('SELECT COUNT(*) AS n FROM fidelity_verdicts').get()?.['n']);

describe('the memo of attestation verdicts, fidelity_verdicts (decision 40 B, 13.12b)', () => {
  it('has one row per (run_id, cwd, fold_version, token) and the fields 13.12b names', () => {
    const { dbPath } = withRun();
    const columns = rawDb(dbPath).prepare('PRAGMA table_info(fidelity_verdicts)').all();
    expect(columns.map((column) => String(column['name'])).sort()).toEqual([...COLUMNS].sort());
    const key = columns
      .filter((column) => Number(column['pk']) > 0)
      .sort((left, right) => Number(left['pk']) - Number(right['pk']))
      .map((column) => String(column['name']));
    expect(key).toEqual(KEY);
  });

  it('removes the rows of a session when the session is deleted', () => {
    const { dbPath, session, run } = withRun();
    insertVerdict(dbPath, run.id, 1);
    expect(verdictCount(dbPath)).toBe(1);
    const db = rawDb(dbPath);
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    expect(verdictCount(dbPath)).toBe(0);
  });

  it('deletes at store open the rows of a fold version other than the current one', () => {
    const { dbPath, store, run } = withRun();
    insertVerdict(dbPath, run.id, -1);
    store.close();
    openStoreAt(dbPath, createFakeClock(START_MS + 10));
    expect(verdictCount(dbPath)).toBe(0);
  });
});
