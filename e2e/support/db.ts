import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { readTx } from '@momonga/foundation';

export type DbRow = Readonly<Record<string, unknown>>;

export const readDb = <Row extends DbRow = DbRow>(file: string, sql: string, ...params: SQLInputValue[]): Row[] => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return readTx(db, () =>
      db
        .prepare(sql)
        .all(...params)
        .map((row) => ({ ...row }) as Row),
    );
  } finally {
    db.close();
  }
};
