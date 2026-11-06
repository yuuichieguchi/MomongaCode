import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import type { Migration } from '@momonga/foundation';
import { PREVIOUS_RELEASE } from '../../src/compat-baseline.ts';
import { MIGRATIONS } from '../../src/schema.ts';
import { makeStoreDir } from '../helpers.ts';

const START_MS = 1_800_000_000_000;

const LIVE_RUN = 'run-live';

const withLiveRun = (through: number): DatabaseSync => {
  const db = new DatabaseSync(path.join(makeStoreDir(), 'runtime.db'));
  migrate(db, MIGRATIONS.filter((migration) => migration.version <= through));
  db.prepare('INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s1', '/work/a', '{}', 'default', 'fm', START_MS);
  db.prepare(
    `INSERT INTO runs (id, session_id, ordinal, status, version, lease_owner, lease_token, lease_expires_at, available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at)
     VALUES (?, 's1', 1, 'RUNNING', 1, 'w1', 1, ?, ?, 1, 0, 0, ?, '{}', '{"inputTokens":0,"outputTokens":0,"totalTokens":0}', 1, 3, '{}', 0, ?)`,
  ).run(LIVE_RUN, START_MS + 1_000_000, START_MS, START_MS + 3_600_000, START_MS);
  const insertEvent = db.prepare('INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json) VALUES (?, ?, ?, ?, 1, ?, ?, ?)');
  insertEvent.run(LIVE_RUN, 's1', 1, 0, START_MS, 'run.started', `{"attempt":1,"mode":"default","now":${START_MS},"pins":{},"type":"run.started"}`);
  insertEvent.run(LIVE_RUN, 's1', 2, 0, START_MS, 'user.message', '{"text":"hi","type":"user.message"}');
  insertEvent.run(LIVE_RUN, 's1', 3, 1, START_MS, 'model.requested', '{"attempt":1,"body":{"input":[],"model":"fm","tools":[]},"digest":"d1","step":1,"type":"model.requested"}');
  return db;
};

const columnsOf = (db: DatabaseSync, table: string): string[] => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column['name']));

const liveRows = (db: DatabaseSync, columns: { runs: string[]; events: string[] }) => ({
  runs: db.prepare(`SELECT ${columns.runs.join(', ')} FROM runs WHERE id = ?`).all(LIVE_RUN),
  events: db.prepare(`SELECT ${columns.events.join(', ')} FROM events WHERE run_id = ? ORDER BY seq`).all(LIVE_RUN),
});

const liveRunRowsChangedBy = (through: number, applied: readonly Migration[]): boolean => {
  const db = withLiveRun(through);
  try {
    const columns = { runs: columnsOf(db, 'runs'), events: columnsOf(db, 'events') };
    const before = liveRows(db, columns);
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= through || applied.includes(migration)));
    return JSON.stringify(liveRows(db, columns)) !== JSON.stringify(before);
  } finally {
    db.close();
  }
};

describe('a backfill in a migration touches no row of a non-terminal run (H7, 11.2 rule 5)', () => {
  it('catches the v18 form, which appended an event to every run and moved its last_seq', () => {
    const v18 = MIGRATIONS.filter((migration) => migration.version === 18);
    expect(liveRunRowsChangedBy(17, v18)).toBe(true);
  });

  it('passes a migration that adds a column and a table only', () => {
    const v21 = MIGRATIONS.filter((migration) => migration.version === 21);
    expect(liveRunRowsChangedBy(20, v21)).toBe(false);
  });

  it.skipIf(PREVIOUS_RELEASE === undefined)('the migrations after the previous release leave the rows of a live run as they were', () => {
    if (PREVIOUS_RELEASE === undefined) throw new Error('no previous release');
    const { lastMigration } = PREVIOUS_RELEASE;
    expect(liveRunRowsChangedBy(lastMigration, MIGRATIONS.filter((migration) => migration.version > lastMigration))).toBe(false);
  });
});
