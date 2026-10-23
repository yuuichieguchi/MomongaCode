import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { isFatalStoreError } from '@momonga/store';
import { harness, newSession, rawDb } from './helpers.ts';

const sqliteError = (errcode: number, errstr = 'sqlite failure'): Error =>
  Object.assign(new Error(errstr), { code: 'ERR_SQLITE_ERROR', errcode, errstr });

const SQLITE_IOERR = 10;
const SQLITE_IOERR_READ = 266;
const SQLITE_IOERR_FSYNC = 1034;
const SQLITE_CORRUPT = 11;
const SQLITE_CORRUPT_VTAB = 267;
const SQLITE_NOTADB = 26;
const SQLITE_READONLY = 8;
const SQLITE_READONLY_DBMOVED = 1032;
const SQLITE_BUSY = 5;
const SQLITE_BUSY_SNAPSHOT = 517;
const SQLITE_CONSTRAINT = 19;
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const SQLITE_FULL = 13;

const thrownBy = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected the action to throw');
};

const garbleRunsSchema = (dbPath: string): void => {
  const raw = new DatabaseSync(dbPath, { defensive: false });
  try {
    raw.exec('PRAGMA writable_schema = ON');
    const version = Number(raw.prepare('PRAGMA schema_version').get()?.['schema_version']);
    raw.prepare("UPDATE sqlite_schema SET sql = 'CREATE TABLE runs (id TEXT' WHERE type = 'table' AND name = 'runs'").run();
    raw.exec(`PRAGMA schema_version = ${version + 1}`);
  } finally {
    raw.close();
  }
};

describe('isFatalStoreError', () => {
  it('classifies the IOERR and CORRUPT families and NOTADB as fatal', () => {
    for (const errcode of [SQLITE_IOERR, SQLITE_IOERR_READ, SQLITE_IOERR_FSYNC, SQLITE_CORRUPT, SQLITE_CORRUPT_VTAB, SQLITE_NOTADB]) {
      expect({ errcode, fatal: isFatalStoreError(sqliteError(errcode)) }).toEqual({ errcode, fatal: true });
    }
  });

  it('classifies the READONLY family, including READONLY_DBMOVED, as fatal', () => {
    for (const errcode of [SQLITE_READONLY, SQLITE_READONLY_DBMOVED]) {
      expect({ errcode, fatal: isFatalStoreError(sqliteError(errcode)) }).toEqual({ errcode, fatal: true });
    }
  });

  it('does not classify BUSY, CONSTRAINT, FULL, row-decoding or non-SQLite errors', () => {
    for (const errcode of [SQLITE_BUSY, SQLITE_BUSY_SNAPSHOT, SQLITE_CONSTRAINT, SQLITE_CONSTRAINT_UNIQUE, SQLITE_FULL]) {
      expect({ errcode, fatal: isFatalStoreError(sqliteError(errcode)) }).toEqual({ errcode, fatal: false });
    }
    expect(isFatalStoreError(new Error('database row runs[r1] is corrupt: column status has unexpected value "BOGUS"'))).toBe(false);
    expect(isFatalStoreError(new Error('disk I/O error'))).toBe(false);
    expect(isFatalStoreError(Object.assign(new Error('string code'), { errcode: '11' }))).toBe(false);
    expect(isFatalStoreError({ errcode: SQLITE_CORRUPT, message: 'not an Error' })).toBe(false);
    expect(isFatalStoreError(undefined)).toBe(false);
    expect(isFatalStoreError('SQLITE_CORRUPT')).toBe(false);
  });

  it('reports a real row-decoding corruption as non-fatal', () => {
    const { dbPath, store } = harness();
    const session = newSession(store);
    rawDb(dbPath).prepare("UPDATE sessions SET env_json = 'not json' WHERE id = ?").run(session.id);

    const error = thrownBy(() => store.getSession(session.id));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/corrupt/);
    expect(isFatalStoreError(error)).toBe(false);
  });

  it('a malformed schema written through a second connection yields a fatal error on the next statement', () => {
    const { dbPath, store } = harness();
    const session = newSession(store);
    garbleRunsSchema(dbPath);

    const error = thrownBy(() => store.getSession(session.id));

    expect(error).toMatchObject({ errcode: expect.any(Number), errstr: expect.any(String) });
    expect(((error as { errcode: number }).errcode & 0xff)).toBe(SQLITE_CORRUPT);
    expect(isFatalStoreError(error)).toBe(true);
  });

  it('a moved database file is fatal', () => {
    const { dir } = harness();
    const original = path.join(dir, 'rollback.db');
    const raw = new DatabaseSync(original);
    raw.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1)');
    fs.renameSync(original, path.join(dir, 'moved.db'));

    const error = thrownBy(() => raw.prepare('INSERT INTO t VALUES (2)').run());
    raw.close();

    expect(error).toMatchObject({ errcode: SQLITE_READONLY_DBMOVED, errstr: expect.any(String) });
    expect(isFatalStoreError(error)).toBe(true);
  });

  it('a file that is not a database is fatal', () => {
    const { dir } = harness();
    const garbage = path.join(dir, 'garbage.db');
    fs.writeFileSync(garbage, 'x'.repeat(4096), { mode: 0o600 });
    const raw = new DatabaseSync(garbage);

    const error = thrownBy(() => raw.prepare('SELECT * FROM sqlite_schema').all());
    raw.close();

    expect(((error as { errcode: number }).errcode & 0xff)).toBe(SQLITE_NOTADB);
    expect(isFatalStoreError(error)).toBe(true);
  });
});
