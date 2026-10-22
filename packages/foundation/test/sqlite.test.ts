import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { immediateTx, migrate, openDatabase } from '@momonga/foundation';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const makeDir = (mode = 0o700): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
  fs.chmodSync(dir, mode);
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const open = (file: string, options?: { busyTimeoutMs?: number }): DatabaseSync => {
  const db = openDatabase(file, options);
  cleanups.push(() => {
    if (db.isOpen) db.close();
  });
  return db;
};

const fileMode = (file: string) => fs.statSync(file).mode & 0o777;
const pragma = (db: DatabaseSync, name: string) => Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const M1 = { version: 1, name: 'init', sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT);' };
const M2 = { version: 2, name: 'b', sql: 'CREATE TABLE b (id INTEGER PRIMARY KEY);' };
const M3 = { version: 3, name: 'c', sql: 'CREATE TABLE c (id INTEGER PRIMARY KEY);' };

const tables = (db: DatabaseSync) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row['name']);

describe('openDatabase', () => {
  it('creates the file with mode 0600 and applies the pragmas', () => {
    const file = path.join(makeDir(), 'x.db');
    const db = open(file);
    expect(fileMode(file)).toBe(0o600);
    expect(pragma(db, 'journal_mode')).toBe('wal');
    expect(pragma(db, 'synchronous')).toBe(1);
    expect(pragma(db, 'foreign_keys')).toBe(1);
    expect(Number(pragma(db, 'busy_timeout'))).toBeGreaterThanOrEqual(1000);
  });

  it('honours an explicit busy timeout', () => {
    const db = open(path.join(makeDir(), 'x.db'), { busyTimeoutMs: 1234 });
    expect(pragma(db, 'busy_timeout')).toBe(1234);
  });

  it('keeps the WAL side files private and removes them on close', () => {
    const file = path.join(makeDir(), 'x.db');
    const db = open(file);
    db.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1);');
    expect(fileMode(`${file}-wal`)).toBe(0o600);
    expect(fileMode(`${file}-shm`)).toBe(0o600);
    db.close();
    expect(fs.existsSync(`${file}-wal`)).toBe(false);
    expect(fs.existsSync(`${file}-shm`)).toBe(false);
  });

  it.each([0o755, 0o750, 0o701])('rejects a parent directory with mode %o, naming the directory and the fix', (mode) => {
    const dir = makeDir(mode);
    const file = path.join(dir, 'x.db');
    expect(() => openDatabase(file)).toThrow(dir);
    expect(() => openDatabase(file)).toThrow(/chmod 700/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects an existing database file that is readable by others, naming the file and the fix', () => {
    const file = path.join(makeDir(), 'x.db');
    open(file).close();
    fs.chmodSync(file, 0o644);
    expect(() => openDatabase(file)).toThrow(file);
    expect(() => openDatabase(file)).toThrow(/chmod 600/);
  });

  it('reopens an existing private database', () => {
    const file = path.join(makeDir(), 'x.db');
    const first = open(file);
    first.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (7);');
    first.close();
    expect(open(file).prepare('SELECT v FROM t').get()).toEqual({ v: 7 });
  });
});

describe('migrate', () => {
  it('applies migrations in version order regardless of input order and records checksums', () => {
    const db = open(path.join(makeDir(), 'x.db'));
    const result = migrate(db, [M2, M1]);
    expect(result.applied).toEqual([1, 2]);
    expect(tables(db)).toEqual(['a', 'b', 'schema_migrations']);
    expect(db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1, name: 'init', checksum: sha256(M1.sql) },
      { version: 2, name: 'b', checksum: sha256(M2.sql) },
    ]);
  });

  it('is idempotent and applies only new migrations', () => {
    const file = path.join(makeDir(), 'x.db');
    const db = open(file);
    expect(migrate(db, [M1]).applied).toEqual([1]);
    expect(migrate(db, [M1]).applied).toEqual([]);
    expect(migrate(db, [M1, M2, M3]).applied).toEqual([2, 3]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 3 });
  });

  it('refuses to run when an applied migration checksum differs, naming the version', () => {
    const db = open(path.join(makeDir(), 'x.db'));
    migrate(db, [M1, M2]);
    const changed = { ...M2, sql: 'CREATE TABLE b (id INTEGER PRIMARY KEY, extra TEXT);' };
    expect(() => migrate(db, [M1, changed, M3])).toThrow(/version 2/);
    expect(() => migrate(db, [M1, changed, M3])).toThrow(/different build/);
    expect(tables(db)).not.toContain('c');
  });

  it('refuses gaps in versions', () => {
    const db = open(path.join(makeDir(), 'x.db'));
    expect(() => migrate(db, [M1, M3])).toThrow(/gap/);
    expect(tables(db)).not.toContain('a');
  });

  it('refuses duplicate versions', () => {
    const db = open(path.join(makeDir(), 'x.db'));
    expect(() => migrate(db, [M1, { ...M2, version: 1 }])).toThrow(/duplicate/);
    expect(tables(db)).not.toContain('a');
  });

  it('rolls back a failing migration entirely', () => {
    const db = open(path.join(makeDir(), 'x.db'));
    migrate(db, [M1]);
    const broken = { version: 2, name: 'broken', sql: 'CREATE TABLE z (id INTEGER); THIS IS NOT SQL;' };
    expect(() => migrate(db, [M1, broken])).toThrow();
    expect(tables(db)).not.toContain('z');
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 1 });
    expect(db.isTransaction).toBe(false);
  });
});

describe('immediateTx', () => {
  const setup = () => {
    const file = path.join(makeDir(), 'x.db');
    const db = open(file);
    db.exec('CREATE TABLE t (v INTEGER)');
    return { file, db };
  };
  const count = (db: DatabaseSync) => db.prepare('SELECT COUNT(*) AS n FROM t').get();

  it('commits and returns the callback value', () => {
    const { db } = setup();
    const value = immediateTx(db, () => {
      db.exec('INSERT INTO t VALUES (1)');
      return 'done';
    });
    expect(value).toBe('done');
    expect(count(db)).toEqual({ n: 1 });
    expect(db.isTransaction).toBe(false);
  });

  it('rolls back and rethrows the original error', () => {
    const { db } = setup();
    const original = new Error('boom');
    let caught: unknown;
    try {
      immediateTx(db, () => {
        db.exec('INSERT INTO t VALUES (1)');
        throw original;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
    expect(count(db)).toEqual({ n: 0 });
    expect(db.isTransaction).toBe(false);
  });

  it('rejects nesting with a clear error and leaves the outer transaction rolled back', () => {
    const { db } = setup();
    expect(() =>
      immediateTx(db, () => {
        db.exec('INSERT INTO t VALUES (1)');
        immediateTx(db, () => 1);
      }),
    ).toThrow(/nested/i);
    expect(count(db)).toEqual({ n: 0 });
    expect(db.isTransaction).toBe(false);
  });

  it('rejects an async callback after rolling back', () => {
    const { db } = setup();
    expect(() =>
      immediateTx(db, () => {
        db.exec('INSERT INTO t VALUES (1)');
        return Promise.resolve(1);
      }),
    ).toThrow(/synchronous/);
    expect(count(db)).toEqual({ n: 0 });
    expect(db.isTransaction).toBe(false);
  });

  it('takes the write lock at BEGIN so a second connection cannot write meanwhile', () => {
    const { file, db } = setup();
    const other = open(file, { busyTimeoutMs: 0 });
    immediateTx(db, () => {
      expect(() => other.exec('INSERT INTO t VALUES (2)')).toThrow(/locked|busy/i);
    });
    other.exec('INSERT INTO t VALUES (2)');
    expect(count(db)).toEqual({ n: 1 });
  });

  it('a second immediateTx on another connection fails fast while the first holds the lock', () => {
    const { file, db } = setup();
    const other = open(file, { busyTimeoutMs: 0 });
    immediateTx(db, () => {
      expect(() => immediateTx(other, () => other.exec('INSERT INTO t VALUES (3)'))).toThrow(/locked|busy/i);
      expect(other.isTransaction).toBe(false);
    });
    expect(count(db)).toEqual({ n: 0 });
  });
});
