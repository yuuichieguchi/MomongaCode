import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openRuntimeStore } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';
import { START_MS, enqueue, harness, makeStoreDir, newSession, openStoreAt, rawDb } from './helpers.ts';

const fileMode = (file: string) => fs.statSync(file).mode & 0o777;

const EXPECTED_TABLES = [
  'approvals',
  'blob_owners',
  'blobs',
  'compaction_guidelines',
  'context_charges',
  'events',
  'governing_facts',
  'idempotency',
  'jobs',
  'memories',
  'memories_index',
  'memories_index_config',
  'memories_index_content',
  'memories_index_data',
  'memories_index_docsize',
  'memories_index_idx',
  'memory_evidence',
  'memory_observations',
  'memory_replacements',
  'meter_records',
  'reflection_jobs',
  'run_records',
  'runs',
  'schema_migrations',
  'search_cursor',
  'search_docs',
  'search_index',
  'search_index_config',
  'search_index_data',
  'search_index_docsize',
  'search_index_idx',
  'session_touched',
  'sessions',
  'snapshots',
  'started_calls',
  'trust',
];

const RUN_COLUMNS = [
  'version',
  'lease_owner',
  'lease_token',
  'lease_expires_at',
  'available_at',
  'attempts',
  'failed_attempts',
  'cancel_requested',
  'deadline_at',
  'limits_json',
  'usage_json',
  'step',
  'last_seq',
  'pins',
  'error_json',
  'dead_letter',
  'ordinal',
];

describe('openRuntimeStore', () => {
  it('creates every table through migrations', () => {
    const { dbPath, store } = harness();
    store.close();
    const db = rawDb(dbPath);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row['name']);
    expect(tables).toEqual(EXPECTED_TABLES);
    const columns = db.prepare('PRAGMA table_info(runs)').all().map((row) => row['name']);
    for (const column of RUN_COLUMNS) expect(columns).toContain(column);
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.['n'])).toBeGreaterThanOrEqual(1);
  });

  it('declares a global autoincrement event id and unique (run_id, seq)', () => {
    const { dbPath, store } = harness();
    store.close();
    const db = rawDb(dbPath);
    const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'events'").get()?.['sql']);
    expect(sql).toMatch(/AUTOINCREMENT/i);
    const uniqueColumnSets = db
      .prepare('PRAGMA index_list(events)')
      .all()
      .filter((index) => index['unique'] === 1)
      .map((index) =>
        db
          .prepare(`PRAGMA index_info("${String(index['name'])}")`)
          .all()
          .map((column) => column['name']),
      );
    expect(uniqueColumnSets).toContainEqual(['run_id', 'seq']);
  });

  it('creates runtime.db with mode 0600', () => {
    const { dbPath } = harness();
    expect(fileMode(dbPath)).toBe(0o600);
  });

  it('rejects a store directory that is not 0700, naming it and the fix', () => {
    const dir = makeStoreDir(0o755);
    const open = () =>
      openRuntimeStore({ path: path.join(dir, 'runtime.db'), home: dir, clock: createFakeClock(START_MS), leaseMs: 1000, maxAttempts: 3, maxTotalAttempts: 100 });
    expect(open).toThrow(dir);
    expect(open).toThrow(/chmod 700/);
    expect(fs.existsSync(path.join(dir, 'runtime.db'))).toBe(false);
  });

  it('refuses a database whose applied migration checksum differs, naming the version', () => {
    const { dbPath, store } = harness();
    store.close();
    const db = rawDb(dbPath);
    db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
    db.close();
    const reopen = () => openRuntimeStore({ path: dbPath, home: path.dirname(dbPath), clock: createFakeClock(START_MS), leaseMs: 1000, maxAttempts: 3, maxTotalAttempts: 100 });
    expect(reopen).toThrow(/version 1/);
    expect(reopen).toThrow(/different build/);
  });

  it('rejects maxTotalAttempts below maxAttempts', () => {
    const dir = makeStoreDir();
    expect(() =>
      openRuntimeStore({ path: path.join(dir, 'runtime.db'), home: dir, clock: createFakeClock(START_MS), leaseMs: 1000, maxAttempts: 3, maxTotalAttempts: 2 }),
    ).toThrow(RangeError);
    expect(fs.existsSync(path.join(dir, 'runtime.db'))).toBe(false);
  });

  it('reopens an existing store and keeps its data', () => {
    const { dbPath, clock, store } = harness();
    const session = newSession(store);
    const run = enqueue(store, session.id);
    store.close();
    const reopened = openStoreAt(dbPath, clock);
    expect(reopened.getRun(run.id)?.status).toBe('QUEUED');
    expect(reopened.getSession(session.id)?.cwd).toBe('/work/a');
  });

  it('close is idempotent and releases the WAL files', () => {
    const { dbPath, store } = harness();
    enqueue(store, newSession(store).id);
    store.close();
    expect(() => store.close()).not.toThrow();
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
  });
});
