import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { highestAppliedMigration, migrate, openDatabase, BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import { createTempDir } from '@momonga/testkit';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const openFresh = (): DatabaseSync => {
  const dir = createTempDir();
  fs.chmodSync(dir, 0o700);
  const db = openDatabase(path.join(dir, 'x.db'), { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
  cleanups.push(() => {
    if (db.isOpen) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
};

const M1 = { version: 1, name: 'init', sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT);' };
const M2 = { version: 2, name: 'b', sql: 'CREATE TABLE b (id INTEGER PRIMARY KEY);' };
const M3 = { version: 3, name: 'c', sql: 'CREATE TABLE c (id INTEGER PRIMARY KEY);' };
const COMPAT = { version: 2, name: 'compat', sql: 'CREATE TABLE store_compat (id INTEGER PRIMARY KEY CHECK (id = 1), min_reader INTEGER NOT NULL, min_reader_release TEXT NOT NULL);' };

describe('migrate on a database a newer build migrated', () => {
  it('accepts an applied version it does not know, reports it, and still checks the known ones', () => {
    const db = openFresh();
    migrate(db, [M1, M2, M3]);
    const result = migrate(db, [M1, M2]);
    expect(result).toEqual({ applied: [], unknownApplied: [3] });
    expect(highestAppliedMigration(db)).toBe(3);
    const changed = { ...M2, sql: 'CREATE TABLE b (id INTEGER PRIMARY KEY, extra TEXT);' };
    expect(() => migrate(db, [M1, changed])).toThrow(/version 2 \(b\) was applied with different SQL/);
  });

  it('refuses a database whose min_reader is above the highest version this build knows, naming the release', () => {
    const db = openFresh();
    migrate(db, [M1, COMPAT, M3]);
    db.prepare('INSERT INTO store_compat (id, min_reader, min_reader_release) VALUES (1, 3, ?)').run('2.0.0');
    expect(() => migrate(db, [M1, COMPAT])).toThrow('this database needs momonga v2.0.0 or newer; update or restart this CLI');
    expect(migrate(db, [M1, COMPAT, M3])).toEqual({ applied: [], unknownApplied: [] });
  });

  it('opens a database whose min_reader this build meets', () => {
    const db = openFresh();
    migrate(db, [M1, COMPAT, M3]);
    db.prepare('INSERT INTO store_compat (id, min_reader, min_reader_release) VALUES (1, 2, ?)').run('1.0.0');
    expect(migrate(db, [M1, COMPAT])).toEqual({ applied: [], unknownApplied: [3] });
  });
});
