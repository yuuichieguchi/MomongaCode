import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../../src/schema.ts';
import { migrationFormViolations } from '../../src/migration-form.ts';
import { START_MS, makeStoreDir, openStoreAt, rawDb } from '../helpers.ts';

const versionTwentyEight = (): string => {
  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  const db = new DatabaseSync(dbPath);
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 28));
    db.prepare('INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s1', '/work/a', '{}', 'default', 'fm', START_MS);
    db.prepare(
      `INSERT INTO runs (id, session_id, ordinal, status, version, lease_owner, lease_token, lease_expires_at, available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at)
       VALUES ('r1', 's1', 1, 'RUNNING', 1, 'w1', 1, ?, ?, 1, 0, 0, ?, '{}', '{"inputTokens":0,"outputTokens":0,"totalTokens":0}', 0, 0, '{}', 0, ?)`,
    ).run(START_MS + 1_000_000, START_MS, START_MS + 3_600_000, START_MS);
    db.prepare(
      `INSERT INTO jobs (id, idem_key, session_id, run_id, call_id, command, status, output_start, output_total, read_offset, started_at)
       VALUES ('bash_1', 'k1', 's1', 'r1', 'c1', 'sleep 1', 'running', 0, 0, 0, ?)`,
    ).run(START_MS);
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
  return dbPath;
};

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: unknown };

const columnOf = (dbPath: string, table: string, column: string): ColumnInfo | undefined =>
  (rawDb(dbPath).prepare(`PRAGMA table_info(${table})`).all() as unknown[]).map((row) => row as ColumnInfo).find((info) => info.name === column);

describe('migration 29: generation ownership of leases and jobs (17.5, 20.51)', () => {
  it('is the highest migration and has only additive forms', () => {
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    expect(last?.version).toBe(29);
    expect(migrationFormViolations(last?.sql ?? 'DROP TABLE missing;')).toEqual([]);
  });

  it('adds four nullable columns without a default to a version-28 database and leaves existing rows NULL', () => {
    const dbPath = versionTwentyEight();
    openStoreAt(dbPath, createFakeClock(START_MS + 10)).close();
    expect(columnOf(dbPath, 'runs', 'lease_generation')).toMatchObject({ type: 'INTEGER', notnull: 0, dflt_value: null });
    expect(columnOf(dbPath, 'jobs', 'owner_generation')).toMatchObject({ type: 'INTEGER', notnull: 0, dflt_value: null });
    expect(columnOf(dbPath, 'jobs', 'kill_requested_at')).toMatchObject({ type: 'INTEGER', notnull: 0, dflt_value: null });
    expect(columnOf(dbPath, 'jobs', 'output_path')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    const db = rawDb(dbPath);
    expect(db.prepare('SELECT lease_generation FROM runs').all().map((row) => row['lease_generation'])).toEqual([null]);
    expect(db.prepare('SELECT owner_generation, kill_requested_at, output_path FROM jobs').all()).toEqual([{ owner_generation: null, kill_requested_at: null, output_path: null }]);
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toMatchObject({ version: 29 });
  });

  it('reads a job row written before the migration without an owner, a kill request or an output path', () => {
    const dbPath = versionTwentyEight();
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 10));
    const job = store.jobs.get('bash_1');
    expect(job).toBeDefined();
    expect(job).not.toHaveProperty('ownerGeneration');
    expect(job).not.toHaveProperty('killRequestedAt');
    expect(job).not.toHaveProperty('outputPath');
  });
});
