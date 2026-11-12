import { describe, expect, it } from 'vitest';
import { RETENTION_TABLES } from '@momonga/store';
import { harness, rawDb } from './helpers.ts';

const REFERENCE_COLUMN = /(^|_)(run|session)_id$/;

describe('the retention registry', () => {
  it('names a rule for every column of the runtime store that holds a run id or a session id', () => {
    const { dbPath } = harness();
    const db = rawDb(dbPath);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((row) => row.name);
    const found: string[] = [];
    for (const table of tables) {
      for (const column of db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]) {
        if (REFERENCE_COLUMN.test(column.name) || (table === 'sessions' && column.name === 'id') || (table === 'runs' && column.name === 'id')) found.push(`${table}.${column.name}`);
      }
    }
    const named = RETENTION_TABLES.map((entry) => `${entry.table}.${entry.column}`);
    expect(found.filter((pair) => !named.includes(pair)).sort()).toEqual([]);
    expect(named.filter((pair) => !found.includes(pair)).sort()).toEqual([]);
  });
});
