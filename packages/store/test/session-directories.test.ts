import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, harness, makeStoreDir, openStoreAt, rawDb } from './helpers.ts';

const populateV3 = (dbPath: string): void => {
  const db = new DatabaseSync(dbPath);
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 3));
    db.prepare(
      `INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at)
       VALUES ('sess-old', '/work/old', '{"PATH":"/usr/bin"}', 'default', 'fm', ?)`,
    ).run(START_MS);
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
};

describe('session additionalDirectories', () => {
  it('stores and returns additionalDirectories', () => {
    const { store } = harness();
    const created = store.createSession({
      cwd: '/work/a',
      env: { PATH: '/usr/bin' },
      permissionMode: 'manual',
      model: 'fm',
      additionalDirectories: ['/work/shared', '/opt/extra'],
    });

    expect(created.additionalDirectories).toEqual(['/work/shared', '/opt/extra']);
    expect(store.getSession(created.id)?.additionalDirectories).toEqual(['/work/shared', '/opt/extra']);
    expect(store.listSessions({ limit: 100, cursor: null }).sessions.map((session) => session.additionalDirectories)).toEqual([['/work/shared', '/opt/extra']]);
  });

  it('defaults to an empty list', () => {
    const { dbPath, store } = harness();
    const created = store.createSession({ cwd: '/work/a', env: {}, permissionMode: 'manual', model: 'fm' });

    expect(created.additionalDirectories).toEqual([]);
    expect(store.getSession(created.id)?.additionalDirectories).toEqual([]);
    expect(rawDb(dbPath).prepare('SELECT additional_directories_json FROM sessions').all()).toEqual([{ additional_directories_json: '[]' }]);
  });

  it('a v3 database migrates existing sessions to empty lists', () => {
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    populateV3(dbPath);
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 100));

    expect(store.getSession('sess-old')).toMatchObject({ cwd: '/work/old', env: { PATH: '/usr/bin' }, additionalDirectories: [] });
    const db = rawDb(dbPath);
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => Number(row['version']))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44]);
    expect(db.prepare('SELECT additional_directories_json FROM sessions').all()).toEqual([{ additional_directories_json: '[]' }]);
  });

  it.each([
    ['not JSON', 'not json'],
    ['a JSON object', '{"a":"/x"}'],
    ['a JSON string', '"/x"'],
    ['a non-string entry', '["/x",1]'],
    ['a relative entry', '["relative/dir"]'],
    ['an empty-string entry', '[""]'],
  ])('a malformed additional_directories_json is reported as corrupt (%s)', (_label, value) => {
    const { dbPath, store } = harness();
    const created = store.createSession({ cwd: '/work/a', env: {}, permissionMode: 'manual', model: 'fm' });
    rawDb(dbPath).prepare('UPDATE sessions SET additional_directories_json = ? WHERE id = ?').run(value, created.id);

    expect(() => store.getSession(created.id)).toThrow(/corrupt/);
  });
});
