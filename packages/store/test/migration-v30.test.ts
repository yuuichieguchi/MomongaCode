import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, makeStoreDir, openStoreAt, rawDb } from './helpers.ts';

const OLD_SESSION_MODEL = 'Local Alias';
const OLD_FACTS_MODEL = 'default';

const versionTwentyNine = (): string => {
  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  const db = new DatabaseSync(dbPath);
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 29));
    db.prepare('INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s1', '/work/a', '{}', 'default', OLD_SESSION_MODEL, START_MS);
    db.prepare(
      `INSERT INTO runs (id, session_id, ordinal, status, version, lease_token, available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at)
       VALUES ('r1', 's1', 1, 'COMPLETED', 1, 1, ?, 1, 0, 0, ?, '{}', '{"inputTokens":0,"outputTokens":0,"totalTokens":0}', 1, 0, '{}', 0, ?)`,
    ).run(START_MS, START_MS + 3_600_000, START_MS);
    db.prepare('INSERT INTO run_facts (run_id, unavailable, definitions_version, root_run_id, session_id, model_alias) VALUES (?, 0, 1, ?, ?, ?)').run('r1', 'r1', 's1', OLD_FACTS_MODEL);
    db.prepare('UPDATE facts_cursor SET definitions_version = 1, after_event_id = 41 WHERE id = 1').run();
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
  return dbPath;
};

const columnsOf = (db: DatabaseSync, table: string): string[] => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column['name']));

describe('migration 30: the model of a session and of a run is called by its own name', () => {
  it('opens a version-29 database with the columns sessions.model and run_facts.model and keeps every value byte for byte', () => {
    const dbPath = versionTwentyNine();
    openStoreAt(dbPath, createFakeClock(START_MS + 1)).close();
    const db = rawDb(dbPath);
    expect(columnsOf(db, 'sessions')).toContain('model');
    expect(columnsOf(db, 'sessions')).not.toContain('model_alias');
    expect(columnsOf(db, 'run_facts')).toContain('model');
    expect(columnsOf(db, 'run_facts')).not.toContain('model_alias');
    expect(db.prepare('SELECT model FROM sessions WHERE id = ?').get('s1')).toEqual({ model: OLD_SESSION_MODEL });
    expect(db.prepare('SELECT model FROM run_facts WHERE run_id = ?').get('r1')).toEqual({ model: OLD_FACTS_MODEL });
    expect(db.prepare('SELECT definitions_version, after_event_id FROM facts_cursor WHERE id = 1').get()).toEqual({ definitions_version: 0, after_event_id: 0 });
  });

  it('is version 30, the first after 29, with its name', () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions.indexOf(30)).toBe(versions.indexOf(29) + 1);
    expect(MIGRATIONS.find((migration) => migration.version === 30)?.name).toBe('call the model of a session and of a run by its own name');
    const dbPath = versionTwentyNine();
    openStoreAt(dbPath, createFakeClock(START_MS + 1)).close();
    expect(rawDb(dbPath).prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: Math.max(...versions) });
  });

  it('does nothing when the database is opened a second time', () => {
    const dbPath = versionTwentyNine();
    openStoreAt(dbPath, createFakeClock(START_MS + 1)).close();
    const before = rawDb(dbPath);
    const migrations = before.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
    const session = before.prepare('SELECT * FROM sessions WHERE id = ?').get('s1');
    before.close();
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 2));
    expect(store.getSession('s1')).toMatchObject({ model: OLD_SESSION_MODEL });
    store.close();
    const after = rawDb(dbPath);
    expect(after.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all()).toEqual(migrations);
    expect(after.prepare('SELECT * FROM sessions WHERE id = ?').get('s1')).toEqual(session);
  });
});
