import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, enqueue, makeStoreDir, mustRun, newSession, openStoreAt, rawDb } from './helpers.ts';

type LegacyRun = { id: string; sessionId: string; ordinal: number; previous: string | null; status: string; attempts: number };

const LEGACY_RUNS: readonly LegacyRun[] = [
  { id: 'run-1', sessionId: 'sess-1', ordinal: 1, previous: null, status: 'COMPLETED', attempts: 1 },
  { id: 'run-2', sessionId: 'sess-1', ordinal: 2, previous: 'run-1', status: 'RUNNING', attempts: 1 },
  { id: 'run-3', sessionId: 'sess-1', ordinal: 3, previous: 'run-2', status: 'QUEUED', attempts: 0 },
  { id: 'run-4', sessionId: 'sess-1', ordinal: 4, previous: 'run-3', status: 'QUEUED', attempts: 1 },
  { id: 'run-5', sessionId: 'sess-2', ordinal: 1, previous: null, status: 'QUEUED', attempts: 0 },
  { id: 'run-6', sessionId: 'sess-3', ordinal: 1, previous: null, status: 'FAILED', attempts: 2 },
  { id: 'run-7', sessionId: 'sess-3', ordinal: 2, previous: 'run-6', status: 'CANCELLED', attempts: 0 },
];

const populateV4 = (dbPath: string): void => {
  const db = new DatabaseSync(dbPath);
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 4));
    for (const sessionId of ['sess-1', 'sess-2', 'sess-3']) {
      db.prepare(
        `INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at)
         VALUES (?, '/work/a', '{"PATH":"/usr/bin"}', 'default', 'fm', ?)`,
      ).run(sessionId, START_MS);
    }
    const insertRun = db.prepare(
      `INSERT INTO runs (id, session_id, ordinal, idempotency_key, request_digest, previous_run_id, status, stop_reason, version, lease_owner,
         lease_token, lease_expires_at, available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step,
         last_seq, pins, error_json, dead_letter, created_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, 1, NULL, 1, NULL, ?, ?, 0, 0, ?, '{}', '{"inputTokens":0,"outputTokens":0,"totalTokens":0}', 0,
         1, '{}', NULL, 0, ?)`,
    );
    const insertEvent = db.prepare(
      `INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json)
       VALUES (?, ?, 1, 0, 1, ?, 'user.message', '{"text":"hello","type":"user.message"}')`,
    );
    for (const run of LEGACY_RUNS) {
      insertRun.run(run.id, run.sessionId, run.ordinal, run.previous, run.status, START_MS, run.attempts, START_MS + 3_600_000, START_MS);
      insertEvent.run(run.id, run.sessionId, START_MS);
    }
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
};

const migrated = () => {
  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  populateV4(dbPath);
  const store = openStoreAt(dbPath, createFakeClock(START_MS + 100));
  return { dbPath, store };
};

const historyModes = (dbPath: string): Record<string, unknown> =>
  Object.fromEntries(rawDb(dbPath).prepare('SELECT id, history_mode FROM runs ORDER BY id').all().map((row) => [row['id'], row['history_mode']]));

describe('migration v5 on a populated v4 database', () => {
  it('records the fifth migration with its name', () => {
    const { dbPath } = migrated();
    const rows = rawDb(dbPath).prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    expect(rows.map((row) => Number(row['version']))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(rows[4]?.['name']).toBe('record whether a run inherits the history of its predecessor');
  });

  it('backfills inherit only for queued runs with a predecessor that never started, and fresh for every other row', () => {
    const { dbPath } = migrated();
    expect(historyModes(dbPath)).toEqual({
      'run-1': 'fresh',
      'run-2': 'fresh',
      'run-3': 'inherit',
      'run-4': 'fresh',
      'run-5': 'fresh',
      'run-6': 'fresh',
      'run-7': 'fresh',
    });
  });

  it('decodes previousRunId and history for the migrated rows', () => {
    const { store } = migrated();
    expect(mustRun(store, 'run-1')).toMatchObject({ previousRunId: null, history: 'fresh' });
    expect(mustRun(store, 'run-3')).toMatchObject({ previousRunId: 'run-2', history: 'inherit' });
    expect(mustRun(store, 'run-4')).toMatchObject({ previousRunId: 'run-3', history: 'fresh' });
  });

  it('rejects a history_mode outside inherit and fresh', () => {
    const { dbPath } = migrated();
    expect(() => rawDb(dbPath).prepare("UPDATE runs SET history_mode = 'other' WHERE id = 'run-1'").run()).toThrow(/CHECK constraint/);
    expect(() => rawDb(dbPath).prepare("UPDATE runs SET history_mode = NULL WHERE id = 'run-1'").run()).toThrow(/NOT NULL/);
  });

  it('writes the history of a new run explicitly after the migration', () => {
    const { dbPath, store } = migrated();
    const session = newSession(store);
    const first = enqueue(store, session.id, 'first');
    const second = enqueue(store, session.id, 'second');
    expect(historyModes(dbPath)[first.id]).toBe('inherit');
    expect(historyModes(dbPath)[second.id]).toBe('inherit');
    expect(mustRun(store, second.id)).toMatchObject({ previousRunId: first.id, history: 'inherit' });
  });
});
