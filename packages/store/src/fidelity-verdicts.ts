import type { DatabaseSync } from 'node:sqlite';
import { FIDELITY_FOLD_VERSION } from '@momonga/protocol';
import { corrupt, readerFor } from './rows.ts';
import type { Row } from './rows.ts';
import { VERDICT_RANKS } from './types.ts';
import type { FidelityReply, FidelityVerdictRow, VerdictRank } from './types.ts';

export type VerdictReader = {
  rowsOf(runId: string, cwd: string, tokens: readonly string[]): Map<string, FidelityVerdictRow>;
};

export type VerdictWriter = {
  record(runId: string, cwd: string, reply: Pick<FidelityReply, 'checkedThrough' | 'verdicts'>): void;
};

const RANK_OF = "CASE %s WHEN 'executed' THEN 2 WHEN 'stated' THEN 1 ELSE 0 END";

const rankSql = (column: string): string => RANK_OF.replace('%s', column);

const handlesOf = (identity: string, column: string, parsed: unknown): string[] => {
  if (!Array.isArray(parsed) || !parsed.every((handle) => typeof handle === 'string')) throw corrupt('fidelity_verdicts', identity, `column ${column} must be a JSON array of blob handles`);
  return parsed;
};

const rankOf = (identity: string, value: string): VerdictRank => {
  const rank = VERDICT_RANKS.find((candidate) => candidate === value);
  if (rank === undefined) throw corrupt('fidelity_verdicts', identity, `column inh must be one of ${VERDICT_RANKS.join(', ')}`);
  return rank;
};

const rowOf = (row: Row): FidelityVerdictRow => {
  const reader = readerFor('fidelity_verdicts', String(row['run_id']), row);
  const identity = `${reader.string('run_id')}/${reader.string('token')}`;
  return {
    token: reader.string('token'),
    inh: rankOf(identity, reader.string('inh')),
    inhDeps: handlesOf(identity, 'inh_deps', reader.json('inh_deps')),
    taskStated: reader.number('task_stated') === 1,
    statedAt: reader.nullableNumber('stated_at'),
    executedAt: reader.nullableNumber('executed_at'),
    ownDeps: handlesOf(identity, 'own_deps', reader.json('own_deps')),
    checkedThrough: reader.number('checked_through'),
  };
};

export const createVerdictReader = (db: DatabaseSync): VerdictReader => {
  const select = db.prepare('SELECT * FROM fidelity_verdicts WHERE run_id = :runId AND cwd = :cwd AND fold_version = :version AND token = :token');
  const blobExists = db.prepare('SELECT 1 AS present FROM blobs WHERE sha256 = :handle');
  return {
    rowsOf: (runId, cwd, tokens) => {
      const rows = new Map<string, FidelityVerdictRow>();
      for (const token of tokens) {
        const found = select.get({ runId, cwd, version: FIDELITY_FOLD_VERSION, token });
        if (found === undefined) continue;
        const row = rowOf(found);
        if ([...row.inhDeps, ...row.ownDeps].every((handle) => blobExists.get({ handle }) !== undefined)) rows.set(token, row);
      }
      return rows;
    },
  };
};

export const createVerdictWriter = (db: DatabaseSync): VerdictWriter => {
  const upsert = db.prepare(
    `INSERT INTO fidelity_verdicts (run_id, cwd, fold_version, token, inh, inh_deps, task_stated, stated_at, executed_at, own_deps, checked_through)
     VALUES (:runId, :cwd, :version, :token, :inh, :inhDeps, :taskStated, :statedAt, :executedAt, :ownDeps, :checkedThrough)
     ON CONFLICT (run_id, cwd, fold_version, token) DO UPDATE SET
       inh = CASE WHEN ${rankSql('excluded.inh')} > ${rankSql('fidelity_verdicts.inh')} THEN excluded.inh ELSE fidelity_verdicts.inh END,
       inh_deps = CASE WHEN ${rankSql('excluded.inh')} > ${rankSql('fidelity_verdicts.inh')} THEN excluded.inh_deps ELSE fidelity_verdicts.inh_deps END,
       task_stated = MAX(fidelity_verdicts.task_stated, excluded.task_stated),
       stated_at = CASE WHEN fidelity_verdicts.stated_at IS NULL THEN excluded.stated_at WHEN excluded.stated_at IS NULL THEN fidelity_verdicts.stated_at ELSE MIN(fidelity_verdicts.stated_at, excluded.stated_at) END,
       own_deps = CASE WHEN excluded.executed_at IS NOT NULL AND (fidelity_verdicts.executed_at IS NULL OR excluded.executed_at < fidelity_verdicts.executed_at) THEN excluded.own_deps ELSE fidelity_verdicts.own_deps END,
       executed_at = CASE WHEN fidelity_verdicts.executed_at IS NULL THEN excluded.executed_at WHEN excluded.executed_at IS NULL THEN fidelity_verdicts.executed_at ELSE MIN(fidelity_verdicts.executed_at, excluded.executed_at) END,
       checked_through = MAX(fidelity_verdicts.checked_through, excluded.checked_through)`,
  );
  return {
    record: (runId, cwd, reply) => {
      for (const verdict of reply.verdicts) {
        upsert.run({
          runId,
          cwd,
          version: FIDELITY_FOLD_VERSION,
          token: verdict.token,
          inh: verdict.inh,
          inhDeps: JSON.stringify(verdict.inhDeps),
          taskStated: verdict.taskStated ? 1 : 0,
          statedAt: verdict.statedAt,
          executedAt: verdict.executedAt,
          ownDeps: JSON.stringify(verdict.ownDeps),
          checkedThrough: reply.checkedThrough,
        });
      }
    },
  };
};
