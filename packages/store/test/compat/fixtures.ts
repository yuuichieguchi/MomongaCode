import type { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../../src/schema.ts';

export const BUILD_HIGHEST_MIGRATION = MIGRATIONS.length;

export const recordNewerMigration = (db: DatabaseSync): void => {
  db.prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)').run(BUILD_HIGHEST_MIGRATION + 1, 'a migration of a newer build', 'f'.repeat(64));
};

export const appendForeignRunEvent = (db: DatabaseSync, runId: string, type: string, payload: Record<string, unknown>): number => {
  const run = db.prepare('SELECT session_id, last_seq, step, lease_token FROM runs WHERE id = ?').get(runId);
  if (run === undefined) throw new Error(`no run ${runId}`);
  const seq = Number(run['last_seq']) + 1;
  db.prepare('INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    runId,
    String(run['session_id']),
    seq,
    Number(run['step']),
    Number(run['lease_token']),
    1_800_000_000_000,
    type,
    JSON.stringify({ type, ...payload }),
  );
  db.prepare('UPDATE runs SET last_seq = ? WHERE id = ?').run(seq, runId);
  return seq;
};

export const appendForeignSessionEvent = (db: DatabaseSync, sessionId: string, type: string, payload: Record<string, unknown>): number => {
  const inserted = db
    .prepare('INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json) VALUES (NULL, ?, NULL, NULL, NULL, ?, ?, ?)')
    .run(sessionId, 1_800_000_000_000, type, JSON.stringify({ type, ...payload }));
  return Number(inserted.lastInsertRowid);
};
