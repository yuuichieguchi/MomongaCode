import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, makeStoreDir, openStoreAt, rawDb } from './helpers.ts';

const columnsOf = (db: DatabaseSync, table: string): string[] => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column['name']));

describe('migration 56: a session keeps the reasoning effort chosen for it', () => {
  it('adds sessions.reasoning_effort to a version-55 database, NULL for every session made before', () => {
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    const db = new DatabaseSync(dbPath);
    try {
      migrate(db, MIGRATIONS.filter((migration) => migration.version <= 55));
      expect(columnsOf(db, 'sessions')).not.toContain('reasoning_effort');
    } finally {
      db.close();
    }
    fs.chmodSync(dbPath, 0o600);
    openStoreAt(dbPath, createFakeClock(START_MS + 1)).close();
    const migrated = rawDb(dbPath);
    expect(columnsOf(migrated, 'sessions')).toContain('reasoning_effort');
    expect(migrated.prepare('SELECT COUNT(*) AS rows FROM sessions WHERE reasoning_effort IS NOT NULL').get()?.['rows']).toBe(0);
    migrated.close();
  });
});
