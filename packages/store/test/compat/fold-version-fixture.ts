import { rawDb } from '../helpers.ts';

export const insertVerdict = (dbPath: string, runId: string, foldVersion: number, token: string): void => {
  rawDb(dbPath)
    .prepare(
      `INSERT INTO fidelity_verdicts (run_id, cwd, fold_version, token, inh, inh_deps, task_stated, stated_at, executed_at, own_deps, checked_through)
       VALUES (?, '/work/a', ?, ?, 'none', '[]', 0, NULL, NULL, '[]', 0)`,
    )
    .run(runId, foldVersion, token);
};

export const foldVersions = (dbPath: string): number[] =>
  rawDb(dbPath)
    .prepare('SELECT fold_version FROM fidelity_verdicts ORDER BY fold_version, token')
    .all()
    .map((row) => Number(row['fold_version']));
