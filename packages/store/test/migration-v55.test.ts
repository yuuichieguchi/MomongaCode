import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, makeStoreDir, openStoreAt, rawDb } from './helpers.ts';

const columnsOf = (db: DatabaseSync, table: string): string[] => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column['name']));

describe('migration 55: a resolved approval keeps the surface that answered it', () => {
  it('adds approvals.resolved_by to a version-54 database, NULL for every row resolved before', () => {
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    const db = new DatabaseSync(dbPath);
    try {
      migrate(db, MIGRATIONS.filter((migration) => migration.version <= 54));
      expect(columnsOf(db, 'approvals')).not.toContain('resolved_by');
    } finally {
      db.close();
    }
    fs.chmodSync(dbPath, 0o600);
    openStoreAt(dbPath, createFakeClock(START_MS + 1)).close();
    const migrated = rawDb(dbPath);
    expect(columnsOf(migrated, 'approvals')).toContain('resolved_by');
    expect(migrated.prepare('SELECT COUNT(*) AS rows FROM approvals WHERE resolved_by IS NOT NULL').get()?.['rows']).toBe(0);
    migrated.close();
  });
});
