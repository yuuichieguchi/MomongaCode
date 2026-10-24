import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { readTx } from '@momonga/foundation';
import { MIGRATIONS } from '../../packages/store/src/schema.ts';

export const TOLERATED_DB_ERRORS: ReadonlySet<string> = new Set(['SQLITE_CANTOPEN', 'SQLITE_BUSY']);

export type DbRow = Readonly<Record<string, unknown>>;

export type ReadDbHooks = { readonly afterQueryFailure?: () => void };

const SQLITE_PRIMARY_CODE_MASK = 0xff;
const SQLITE_NAMES_BY_PRIMARY_CODE: Readonly<Record<number, string>> = { 5: 'SQLITE_BUSY', 14: 'SQLITE_CANTOPEN' };

const isToleratedDbError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null || !('errcode' in error) || typeof error.errcode !== 'number') return false;
  const name = SQLITE_NAMES_BY_PRIMARY_CODE[error.errcode & SQLITE_PRIMARY_CODE_MASK];
  return name !== undefined && TOLERATED_DB_ERRORS.has(name);
};

const isMissingTableError = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith('no such table:');

const hasRecordedEveryMigration = (db: DatabaseSync): boolean => {
  try {
    const row = db.prepare('SELECT count(*) AS recorded FROM schema_migrations').get();
    return typeof row?.recorded === 'number' && row.recorded >= MIGRATIONS.length;
  } catch (error) {
    if (isMissingTableError(error)) return false;
    throw error;
  }
};

const queryReadOnly = <Row extends DbRow>(file: string, sql: string, params: readonly SQLInputValue[], hooks: ReadDbHooks): Row[] => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return readTx(db, () => {
      try {
        return db
          .prepare(sql)
          .all(...params)
          .map((row) => ({ ...row }) as Row);
      } catch (error) {
        hooks.afterQueryFailure?.();
        if (isMissingTableError(error) && !hasRecordedEveryMigration(db)) return [];
        throw error;
      }
    });
  } finally {
    db.close();
  }
};

export const readDbWithHooks = <Row extends DbRow = DbRow>(
  hooks: ReadDbHooks,
  file: string,
  sql: string,
  ...params: SQLInputValue[]
): Row[] => {
  try {
    return queryReadOnly<Row>(file, sql, params, hooks);
  } catch (error) {
    if (isToleratedDbError(error)) return [];
    throw error;
  }
};

export const readDb = <Row extends DbRow = DbRow>(file: string, sql: string, ...params: SQLInputValue[]): Row[] =>
  readDbWithHooks<Row>({}, file, sql, ...params);
