import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, makeStoreDir, openStoreAt, rawDb } from './helpers.ts';

const ADDED = [
  { table: 'runs', name: 'lease_generation', type: 'INTEGER' },
  { table: 'jobs', name: 'owner_generation', type: 'INTEGER' },
  { table: 'jobs', name: 'kill_requested_at', type: 'INTEGER' },
  { table: 'jobs', name: 'output_path', type: 'TEXT' },
] as const;

const TABLES = ['runs', 'jobs'] as const;

const sqlOf = (version: number): string => {
  const migration = MIGRATIONS.find((entry) => entry.version === version);
  if (migration === undefined) throw new Error(`no migration ${version}`);
  return migration.sql;
};

const statementsOf = (sql: string): string[] =>
  sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');

const versionTwentyNine = (): string => {
  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  const db = new DatabaseSync(dbPath);
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 29));
    db.prepare("INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at) VALUES ('s1', '/work/a', '{}', 'default', 'fm', ?)").run(START_MS);
    db.prepare(
      `INSERT INTO runs (id, session_id, ordinal, status, version, lease_token, available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at)
       VALUES ('r1', 's1', 1, 'COMPLETED', 1, 1, ?, 1, 0, 0, ?, '{}', '{"inputTokens":0,"outputTokens":0,"totalTokens":0}', 1, 0, '{}', 0, ?)`,
    ).run(START_MS, START_MS + 3_600_000, START_MS);
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
  return dbPath;
};

type Column = { name: string; type: string; notnull: number; dflt_value: unknown };

const columnsOf = (db: DatabaseSync, table: string): Column[] => db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Column[];

const schemaOf = (db: DatabaseSync, table: string): string => String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string }).sql);

describe('migration 30: the generation that holds a run lease, and the owner, kill time and output file of a background job (design/supervisor-update.md section 9.1)', () => {
  it('is version 30, the first after 29, and is four ALTER TABLE ADD COLUMN statements and nothing else', () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions.indexOf(30)).toBe(versions.indexOf(29) + 1);
    expect(MIGRATIONS.find((migration) => migration.version === 30)).not.toHaveProperty('rebuildsReferencedTable');
    expect(statementsOf(sqlOf(30))).toEqual(ADDED.map((column) => `ALTER TABLE ${column.table} ADD COLUMN ${column.name} ${column.type}`));
  });

  it('adds the four columns as nullable with no default, and changes no CHECK, constraint or other column of runs and jobs', () => {
    const dbPath = versionTwentyNine();
    const before = rawDb(dbPath);
    const columnsBefore = Object.fromEntries(TABLES.map((table) => [table, columnsOf(before, table)]));
    const schemaBefore = Object.fromEntries(TABLES.map((table) => [table, schemaOf(before, table)]));
    before.close();
    const db = new DatabaseSync(dbPath);
    try {
      migrate(db, MIGRATIONS.filter((migration) => migration.version <= 30));
      for (const table of TABLES) {
        const added = ADDED.filter((column) => column.table === table);
        expect(columnsOf(db, table)).toEqual([...(columnsBefore[table] as Column[]), ...added.map((column) => expect.objectContaining({ name: column.name, type: column.type, notnull: 0, dflt_value: null }))]);
        const schema = schemaOf(db, table);
        for (const column of added) expect(schema.split(` ${column.name} ${column.type}`)).toHaveLength(2);
        expect(added.reduce((text, column) => text.replace(`, ${column.name} ${column.type}`, ''), schema)).toBe(schemaBefore[table]);
      }
    } finally {
      db.close();
    }
  });

  it('backfills nothing: a row written before the migration reads NULL in the new column, the no-lease case', () => {
    const dbPath = versionTwentyNine();
    const db = new DatabaseSync(dbPath);
    try {
      migrate(db, MIGRATIONS.filter((migration) => migration.version <= 30));
      expect(db.prepare("SELECT lease_generation FROM runs WHERE id = 'r1'").get()).toEqual({ lease_generation: null });
    } finally {
      db.close();
    }
  });

  it('is applied once by the store at open, and a second open changes nothing', () => {
    const dbPath = versionTwentyNine();
    openStoreAt(dbPath, createFakeClock(START_MS + 1)).close();
    const first = rawDb(dbPath);
    expect(first.prepare('SELECT version FROM schema_migrations WHERE version = 30').get()).toEqual({ version: 30 });
    const migrations = first.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
    const run = first.prepare("SELECT * FROM runs WHERE id = 'r1'").get();
    expect(run).toMatchObject({ lease_generation: null });
    first.close();
    openStoreAt(dbPath, createFakeClock(START_MS + 2)).close();
    const second = rawDb(dbPath);
    expect(second.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all()).toEqual(migrations);
    expect(second.prepare("SELECT * FROM runs WHERE id = 'r1'").get()).toEqual(run);
  });
});
