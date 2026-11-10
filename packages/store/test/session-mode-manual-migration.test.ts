import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import type { Migration } from '@momonga/foundation';
import { PERMISSION_MODES } from '@momonga/protocol';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, makeStoreDir } from './helpers.ts';

const renaming = (): Migration => {
  const found = MIGRATIONS.filter((migration) => /asking mode .*manual/.test(migration.name));
  if (found.length !== 1 || found[0] === undefined) throw new Error(`expected one migration that renames the asking mode, found ${found.length}`);
  return found[0];
};

const openBefore = (): DatabaseSync => {
  const db = new DatabaseSync(path.join(makeStoreDir(), 'runtime.db'));
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, MIGRATIONS.filter((migration) => migration.version < renaming().version));
  return db;
};

const insertSession = (db: DatabaseSync, id: string, mode: string): void => {
  db.prepare(
    `INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at, bypass_allowed, additional_directories_json, mcp_servers_json)
     VALUES (?, ?, '{"A":"1"}', ?, 'fm', ?, 1, '["/extra"]', '{"s":{"command":"x"}}')`,
  ).run(id, `/work/${id}`, mode, START_MS);
};

const namesOf = (db: DatabaseSync, type: string, table: string): string[] =>
  db
    .prepare('SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ? ORDER BY name')
    .all(type, table)
    .map((row) => String(row['name']))
    .filter((name) => !name.startsWith('sqlite_autoindex'));

const checkList = (db: DatabaseSync): string[] => {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
  const match = /permission_mode\s+IN\s*\(([^)]*)\)/.exec(String(row?.['sql']));
  if (match === null) throw new Error('sessions has no permission_mode CHECK list');
  return [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => String(entry[1]));
};

describe('the stored asking mode is manual (design 8.3)', () => {
  it('is one step of its own and rebuilds a referenced table', () => {
    const migration = renaming();
    expect(MIGRATIONS.filter((candidate) => candidate.version === migration.version)).toEqual([migration]);
    expect(migration.rebuildsReferencedTable).toBe(true);
  });

  it('rewrites a stored default to manual and keeps every other column and every other mode', () => {
    const db = openBefore();
    try {
      insertSession(db, 'old', 'default');
      for (const mode of ['acceptEdits', 'plan', 'auto', 'bypassPermissions']) insertSession(db, mode, mode);
      const before = db.prepare("SELECT * FROM sessions WHERE id <> 'old' ORDER BY id").all();
      migrate(db, MIGRATIONS.filter((migration) => migration.version <= renaming().version));
      expect(db.prepare("SELECT * FROM sessions WHERE id = 'old'").get()).toEqual({
        id: 'old',
        cwd: '/work/old',
        env_json: '{"A":"1"}',
        permission_mode: 'manual',
        model_alias: 'fm',
        created_at: START_MS,
        bypass_allowed: 1,
        additional_directories_json: '["/extra"]',
        mcp_servers_json: '{"s":{"command":"x"}}',
      });
      expect(db.prepare("SELECT * FROM sessions WHERE id <> 'old' ORDER BY id").all()).toEqual(before);
    } finally {
      db.close();
    }
  });

  it('accepts exactly the five mode names afterwards and refuses default', () => {
    const db = openBefore();
    try {
      migrate(db, MIGRATIONS.filter((migration) => migration.version <= renaming().version));
      expect(checkList(db)).toEqual([...PERMISSION_MODES]);
      for (const mode of PERMISSION_MODES) insertSession(db, mode, mode);
      expect(() => insertSession(db, 'refused', 'default')).toThrow(/CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it('keeps the columns, the index and the triggers of sessions, and leaves no broken reference', () => {
    const db = openBefore();
    try {
      insertSession(db, 'old', 'default');
      const columnsBefore = db.prepare('PRAGMA table_info(sessions)').all().map((column) => ({ ...column, cid: undefined }));
      const indexesBefore = namesOf(db, 'index', 'sessions');
      const triggersBefore = namesOf(db, 'trigger', 'sessions');
      const allTriggersBefore = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
      migrate(db, MIGRATIONS.filter((migration) => migration.version <= renaming().version));
      expect(db.prepare('PRAGMA table_info(sessions)').all().map((column) => ({ ...column, cid: undefined }))).toEqual(columnsBefore);
      expect(namesOf(db, 'index', 'sessions')).toEqual(indexesBefore);
      expect(triggersBefore).toEqual(['fidelity_verdicts_session_delete', 'search_docs_session_delete']);
      expect(namesOf(db, 'trigger', 'sessions')).toEqual(triggersBefore);
      expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()).toEqual(allTriggersBefore);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'sessions_%' AND type = 'table'").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('leaves the append-only history as written: an old mode word in an event stays', () => {
    const db = openBefore();
    try {
      insertSession(db, 'old', 'default');
      const eventColumns = db.prepare('PRAGMA table_info(events)').all().map((column) => String(column['name']));
      expect(eventColumns).toContain('payload_json');
      db.prepare("INSERT INTO events (session_id, type, payload_json, created_at) VALUES ('old', 'mode.changed', ?, ?)").run('{"type":"mode.changed","from":"default","to":"plan"}', START_MS);
      migrate(db, MIGRATIONS.filter((migration) => migration.version <= renaming().version));
      expect(db.prepare("SELECT payload_json FROM events WHERE session_id = 'old'").all()).toEqual([{ payload_json: '{"type":"mode.changed","from":"default","to":"plan"}' }]);
    } finally {
      db.close();
    }
  });
});
