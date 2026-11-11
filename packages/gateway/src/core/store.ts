import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { immediateTx, migrate, openDatabase } from '@momonga/foundation';
import type { Migration } from '@momonga/foundation';
import type { CompactResource, InputItem, ItemField, StreamEvent } from '@momonga/protocol';
import type { StoredDataChecks } from './validation.ts';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'gateway-core',
    sql: `
      CREATE TABLE responses (
        id TEXT PRIMARY KEY,
        input_json TEXT NOT NULL,
        output_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE idempotency (
        key TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        stored_at_ms INTEGER NOT NULL,
        frames_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE usage (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        response_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        step INTEGER,
        target TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        usage_source TEXT NOT NULL,
        recorded_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX usage_by_run ON usage (run_id, seq);
    `,
  },
  {
    version: 2,
    name: 'gateway-compactions',
    sql: `
      CREATE TABLE compactions (
        key TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        resource_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 3,
    name: 'gateway-sends',
    sql: `
      CREATE TABLE sends (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        call_key TEXT NOT NULL,
        target TEXT NOT NULL,
        run_id TEXT,
        step INTEGER,
        sent_at_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX sends_by_call ON sends (call_key, seq);
      ALTER TABLE usage ADD COLUMN retry_of_seq INTEGER;
    `,
  },
  {
    version: 4,
    name: 'gateway-usage-removed',
    sql: `
      DROP INDEX usage_by_run;
      DROP TABLE usage;
    `,
  },
];

export type StoredResponse = { input: InputItem[]; output: ItemField[] };

export type StoredIdempotency = { digest: string; storedAtMs: number; frames: StreamEvent[] };

export type SendRecord = { callKey: string; target: string; runId: string | null; step: number | null; sentAtMs: number };

export type RecordedSend = { seq: number; retryOfSeq: number | undefined };

export type StoredCompaction = { digest: string; expiresAtMs: number; resource: CompactResource };

export type CompactionCommit = { key: string; digest: string; resource: CompactResource; createdAtMs: number; expiresAtMs: number };

export type CommitRequest = {
  recordedAtMs: number;
  idempotencyExpiredBeforeMs: number;
  response?: { id: string; input: InputItem[]; output: ItemField[] };
  idempotency?: { key: string; digest: string; frames: StreamEvent[] };
};

export type GatewayStore = {
  getResponse(id: string): StoredResponse | undefined;
  getIdempotency(key: string): StoredIdempotency | undefined;
  deleteIdempotency(key: string): void;
  commit(request: CommitRequest): void;
  recordSend(send: SendRecord): RecordedSend;
  getCompaction(key: string): StoredCompaction | undefined;
  deleteCompaction(key: string): void;
  commitCompaction(commit: CompactionCommit): void;
  close(): void;
};

const requireString = (value: unknown, column: string): string => {
  if (typeof value !== 'string') throw new TypeError(`gateway database column ${column} is not text`);
  return value;
};

const requireNumber = (value: unknown, column: string): number => {
  if (typeof value !== 'number') throw new TypeError(`gateway database column ${column} is not an integer`);
  return value;
};

type RowLocation = { table: string; keyColumn: string; key: string; column: string };

const locationText = (location: RowLocation): string =>
  `gateway database table ${location.table} (${location.keyColumn} ${location.key}) column ${location.column}`;

const parseCheckedObject = (json: string, location: RowLocation, check: (value: unknown) => string | undefined): unknown => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`${locationText(location)} is not valid JSON`, { cause: error });
  }
  const problem = check(parsed);
  if (problem !== undefined) throw new Error(`${locationText(location)} failed validation: ${problem}`);
  return parsed;
};

const parseChecked = (json: string, location: RowLocation, check: (value: unknown) => string | undefined): unknown[] => {
  const parsed = parseCheckedObject(json, location, check);
  if (!Array.isArray(parsed)) throw new Error(`${locationText(location)} failed validation: is not an array`);
  return parsed;
};

type Statements = {
  getResponse: StatementSync;
  putResponse: StatementSync;
  getIdempotency: StatementSync;
  putIdempotency: StatementSync;
  deleteIdempotency: StatementSync;
  pruneIdempotency: StatementSync;
  getCompaction: StatementSync;
  putCompaction: StatementSync;
  deleteCompaction: StatementSync;
  pruneCompactions: StatementSync;
  firstSend: StatementSync;
  putSend: StatementSync;
  pruneSends: StatementSync;
};

const prepare = (db: DatabaseSync): Statements => ({
  getResponse: db.prepare('SELECT input_json, output_json FROM responses WHERE id = ?'),
  putResponse: db.prepare('INSERT INTO responses (id, input_json, output_json, created_at_ms) VALUES (?, ?, ?, ?)'),
  getIdempotency: db.prepare('SELECT digest, stored_at_ms, frames_json FROM idempotency WHERE key = ?'),
  putIdempotency: db.prepare('INSERT OR REPLACE INTO idempotency (key, digest, stored_at_ms, frames_json) VALUES (?, ?, ?, ?)'),
  deleteIdempotency: db.prepare('DELETE FROM idempotency WHERE key = ?'),
  pruneIdempotency: db.prepare('DELETE FROM idempotency WHERE stored_at_ms <= ?'),
  getCompaction: db.prepare('SELECT digest, resource_json, expires_at FROM compactions WHERE key = ?'),
  putCompaction: db.prepare(
    'INSERT OR REPLACE INTO compactions (key, digest, resource_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ),
  deleteCompaction: db.prepare('DELETE FROM compactions WHERE key = ?'),
  pruneCompactions: db.prepare('DELETE FROM compactions WHERE expires_at <= ?'),
  firstSend: db.prepare('SELECT MIN(seq) AS seq FROM sends WHERE call_key = ?'),
  putSend: db.prepare('INSERT INTO sends (call_key, target, run_id, step, sent_at_ms) VALUES (?, ?, ?, ?, ?)'),
  pruneSends: db.prepare('DELETE FROM sends WHERE sent_at_ms <= ?'),
});

export const openGatewayStore = (dbPath: string, checks: StoredDataChecks): GatewayStore => {
  const db = openDatabase(dbPath);
  try {
    migrate(db, MIGRATIONS);
    const statements = prepare(db);
    return {
      getResponse: (id) => {
        const row = statements.getResponse.get(id);
        if (row === undefined) return undefined;
        return {
          input: parseChecked(
            requireString(row['input_json'], 'input_json'),
            { table: 'responses', keyColumn: 'id', key: id, column: 'input_json' },
            checks.inputItems,
          ) as InputItem[],
          output: parseChecked(
            requireString(row['output_json'], 'output_json'),
            { table: 'responses', keyColumn: 'id', key: id, column: 'output_json' },
            checks.outputItems,
          ) as ItemField[],
        };
      },
      getIdempotency: (key) => {
        const row = statements.getIdempotency.get(key);
        if (row === undefined) return undefined;
        return {
          digest: requireString(row['digest'], 'digest'),
          storedAtMs: requireNumber(row['stored_at_ms'], 'stored_at_ms'),
          frames: parseChecked(
            requireString(row['frames_json'], 'frames_json'),
            { table: 'idempotency', keyColumn: 'key', key, column: 'frames_json' },
            checks.streamEvents,
          ) as StreamEvent[],
        };
      },
      deleteIdempotency: (key) => {
        statements.deleteIdempotency.run(key);
      },
      getCompaction: (key) => {
        const row = statements.getCompaction.get(key);
        if (row === undefined) return undefined;
        return {
          digest: requireString(row['digest'], 'digest'),
          expiresAtMs: requireNumber(row['expires_at'], 'expires_at'),
          resource: parseCheckedObject(
            requireString(row['resource_json'], 'resource_json'),
            { table: 'compactions', keyColumn: 'key', key, column: 'resource_json' },
            checks.compactResource,
          ) as CompactResource,
        };
      },
      deleteCompaction: (key) => {
        statements.deleteCompaction.run(key);
      },
      commitCompaction: (commit) => {
        immediateTx(db, () => {
          statements.pruneCompactions.run(commit.createdAtMs);
          statements.putCompaction.run(commit.key, commit.digest, JSON.stringify(commit.resource), commit.createdAtMs, commit.expiresAtMs);
        });
      },
      commit: (request) => {
        immediateTx(db, () => {
          statements.pruneIdempotency.run(request.idempotencyExpiredBeforeMs);
          statements.pruneSends.run(request.idempotencyExpiredBeforeMs);
          if (request.response !== undefined) {
            const { id, input, output } = request.response;
            statements.putResponse.run(id, JSON.stringify(input), JSON.stringify(output), request.recordedAtMs);
          }
          if (request.idempotency !== undefined) {
            const { key, digest, frames } = request.idempotency;
            statements.putIdempotency.run(key, digest, request.recordedAtMs, JSON.stringify(frames));
          }
        });
      },
      recordSend: (send) =>
        immediateTx(db, () => {
          const first = statements.firstSend.get(send.callKey)?.['seq'];
          const inserted = statements.putSend.run(send.callKey, send.target, send.runId, send.step, send.sentAtMs);
          return { seq: Number(inserted.lastInsertRowid), retryOfSeq: first === null || first === undefined ? undefined : requireNumber(first, 'seq') };
        }),
      close: () => {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
};
