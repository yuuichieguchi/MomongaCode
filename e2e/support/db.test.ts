import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { MIGRATIONS } from '../../packages/store/src/schema.ts';
import { readDb } from './db.ts';
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

describe('readDb throws when the read fails, so a negative assertion never reads a failure as no rows and a poll tries again', () => {
  it('throws when another connection holds the database exclusively', (context) => {
    const file = databaseFile(context);
    const holder = new DatabaseSync(file);
    migrate(holder, MIGRATIONS);
    holder.exec('BEGIN EXCLUSIVE');
    try {
      expect(() => readDb(file, TOOL_GROUPS_SQL)).toThrow(/locked|busy/i);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  it('throws for a database that does not exist', (context) => {
    expect(() => readDb(path.join(withTempDir(context), 'missing.db'), TOOL_GROUPS_SQL)).toThrow(/unable to open/i);
  });

  it('throws while the migrations are only partly recorded', (context) => {
    const file = databaseFile(context);
    recordMigrations(file, MIGRATIONS.length - 1);
    expect(() => readDb(file, TOOL_GROUPS_SQL)).toThrow(/no such table: idempotency/);
  });
});
