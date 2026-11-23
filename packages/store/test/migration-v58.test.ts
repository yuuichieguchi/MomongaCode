import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, cancelToEnd, enqueue, harness, makeStoreDir, newSession, openStoreAt, rawDb } from './helpers.ts';

const PROJECT = '/work/a';

const columnsOf = (db: DatabaseSync, table: string): string[] => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column['name']));

const tableNames = (db: DatabaseSync): string[] => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => String(row['name']));

const versionFiftySevenWithMemories = async () => {
  const source = harness();
  const session = newSession(source.store, PROJECT);
  const run = await enqueue(source.store, session.id);
  await cancelToEnd(source.store, run.id);
  const save = (ordinal: number, text: string) =>
    source.store.memories.saveCandidate({ scope: 'project', origin: 'trusted', project: PROJECT, text, runId: run.id, ordinal, kind: 'fact', evidence: [] }).memory;
  const accepted = save(0, 'tests live in test/');
  source.clock.advance(1);
  const waiting = save(1, 'run npm test before a commit');
  source.store.memories.accept(accepted.id);
  source.store.close();

  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  const db = new DatabaseSync(dbPath);
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 57));
    expect(tableNames(db)).not.toContain('memory_judgements');
    const columns = columnsOf(db, 'memories').join(', ');
    db.exec(`ATTACH DATABASE '${source.dbPath}' AS head`);
    db.exec(`INSERT INTO memories (${columns}) SELECT ${columns} FROM head.memories ORDER BY created_at, id`);
    db.exec('DETACH DATABASE head');
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
  return { dbPath, accepted, waiting };
};

describe('migration 58: memory judgements of auto mode', () => {
  it('is the newest migration and names the session event it records', () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 58);
    expect(migration?.name).toMatch(/memory\.judged/);
    expect(migration?.name).toMatch(/memory_classifier/);
  });

  it('adds memory_judgements and leaves every existing memory not kept by a classifier and without a record', async () => {
    const { dbPath, accepted, waiting } = await versionFiftySevenWithMemories();
    const columnsBefore = (() => {
      const db = rawDb(dbPath);
      try {
        return columnsOf(db, 'memories');
      } finally {
        db.close();
      }
    })();
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 1));
    try {
      expect(store.memories.get(accepted.id)).toMatchObject({ state: 'active', keptByClassifier: null });
      expect(store.memories.get(waiting.id)).toMatchObject({ state: 'candidate', keptByClassifier: null });
      expect(store.memoryJudgements.get(accepted.id)).toBeUndefined();
      expect(store.memoryJudgements.get(waiting.id)).toBeUndefined();
      expect(store.memoryJudgements.owed(PROJECT)).toEqual([]);
      expect(store.memoryJudgements.next(PROJECT)?.id).toBe(waiting.id);
    } finally {
      store.close();
    }
    const migrated = rawDb(dbPath);
    expect(tableNames(migrated)).toContain('memory_judgements');
    expect(columnsOf(migrated, 'memories').length).toBe(columnsBefore.length + 1);
    expect(migrated.prepare('SELECT COUNT(*) AS rows FROM memory_judgements').get()?.['rows']).toBe(0);
    migrated.close();
  });
});
