import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { MIGRATIONS } from '../../packages/store/src/schema.ts';
import { readDb, readDbWithHooks } from './db.ts';
import { TOOL_GROUPS_SQL } from './ledger.ts';

const CREATE_SCHEMA_MIGRATIONS = 'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL)';

const databaseFile = (context: Parameters<typeof withTempDir>[0]): string => path.join(withTempDir(context), 'runtime.db');

const recordMigrations = (file: string, count: number): void => {
  const db = new DatabaseSync(file);
  db.exec(CREATE_SCHEMA_MIGRATIONS);
  const insert = db.prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)');
  for (const migration of MIGRATIONS.slice(0, count)) insert.run(migration.version, migration.name, 'x');
  db.close();
};

describe('readDb during the runtime migration window', () => {
  it('returns no rows for an empty database file without schema_migrations', (context) => {
    const file = databaseFile(context);
    fs.writeFileSync(file, '');
    expect(readDb(file, TOOL_GROUPS_SQL)).toEqual([]);
  });

  it('returns no rows while the migrations are only partly recorded', (context) => {
    const file = databaseFile(context);
    recordMigrations(file, MIGRATIONS.length - 1);
    expect(readDb(file, TOOL_GROUPS_SQL)).toEqual([]);
  });

  it('returns no rows when schema_migrations exists but records nothing', (context) => {
    const file = databaseFile(context);
    recordMigrations(file, 0);
    expect(readDb(file, TOOL_GROUPS_SQL)).toEqual([]);
  });

  it('throws no such table once every migration is recorded and the table is still missing', (context) => {
    const file = databaseFile(context);
    recordMigrations(file, MIGRATIONS.length);
    expect(() => readDb(file, TOOL_GROUPS_SQL)).toThrow(/no such table: idempotency/);
  });

  it('throws other query errors on a database that is not migrated', (context) => {
    const file = databaseFile(context);
    recordMigrations(file, 0);
    expect(() => readDb(file, 'SELEC pgid FROM idempotency')).toThrow(/syntax error/);
  });

  it('reads the idempotency table of a database migrated with the runtime migration list', (context) => {
    const file = databaseFile(context);
    const db = new DatabaseSync(file);
    migrate(db, MIGRATIONS);
    db.exec("INSERT INTO idempotency (key, state, meta_json, pgid, created_at, expires_at) VALUES ('k', 'PENDING', '{}', 4242, 1, 2)");
    db.close();
    expect(readDb<{ pgid: number }>(file, TOOL_GROUPS_SQL)).toEqual([{ pgid: 4242 }]);
  });

  it('returns no rows when the runtime finishes migrating between the failed query and the migration check', (context) => {
    const file = databaseFile(context);
    const runtime = new DatabaseSync(file);
    runtime.exec('PRAGMA journal_mode = WAL');
    migrate(runtime, []);
    let completions = 0;
    const completeMigrations = (): void => {
      const late = new DatabaseSync(file);
      migrate(late, MIGRATIONS);
      late.close();
      completions += 1;
    };
    try {
      expect(readDbWithHooks({ afterQueryFailure: completeMigrations }, file, TOOL_GROUPS_SQL)).toEqual([]);
      expect(completions).toBe(1);
    } finally {
      runtime.close();
    }
  });
});
