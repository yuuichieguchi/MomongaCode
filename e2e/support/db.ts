import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { busyTimeoutMs, readTx } from '@momonga/foundation';
import { DEFAULT_LEASE_MS } from '../../packages/runtime/src/process/start-runtime-process.ts';
import { heartbeatMsFor } from '../../packages/runtime/src/worker/heartbeat.ts';

export const E2E_DB_BUSY_WAIT_MS = busyTimeoutMs(heartbeatMsFor(DEFAULT_LEASE_MS));

export type DbRow = Readonly<Record<string, unknown>>;

export const readDb = <Row extends DbRow = DbRow>(file: string, sql: string, ...params: SQLInputValue[]): Row[] => {
  const db = new DatabaseSync(file, { readOnly: true, timeout: E2E_DB_BUSY_WAIT_MS });
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
