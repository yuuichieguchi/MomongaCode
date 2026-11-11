import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import type { MemoryRecord, RuntimeStore } from '@momonga/store';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, callEvent, enqueue, harness, makeStoreDir, mustClaim, newSession, openStoreAt, rawDb } from './helpers.ts';

const PROJECT = '/work/a';

const EVIDENCE_COLUMNS = 'memory_id, ordinal, kind, project, path, sha256, sha, run_id, call_id, seq, command, exit_code';

const saveNote = async (store: RuntimeStore, runId: string, callId: string, text: string, supersedes: string[] = []): Promise<MemoryRecord> =>
  (
    await store.memories.save({
      origin: 'trusted',
      scope: 'project',
      project: PROJECT,
      text,
      runId,
      step: 1,
      callId,
      evidence: [{ kind: 'file', project: PROJECT, path: 'src/a.ts', sha256: 'a'.repeat(64) }],
      supersedes,
    })
  ).memory;

const versionThirtyEightWithMemories = async (): Promise<{ dbPath: string; first: MemoryRecord; successor: MemoryRecord }> => {
  const source = harness();
  const session = newSession(source.store, PROJECT);
  const run = await enqueue(source.store, session.id);
  const claim = mustClaim(source.store, 'w1');
  expect(source.store.append(claim, ['c1', 'c2'].map(callEvent)).kind).toBe('ok');
  const first = await saveNote(source.store, run.id, 'c1', 'tests live in test/');
  const successor = await saveNote(source.store, run.id, 'c2', 'tests live in packages/*/test', [first.id]);
  source.store.close();

  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  const db = new DatabaseSync(dbPath);
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 38));
    db.exec(`ATTACH DATABASE '${source.dbPath}' AS head`);
    db.exec('INSERT INTO memories SELECT * FROM head.memories ORDER BY created_at, id');
    db.exec(`INSERT INTO memory_evidence (${EVIDENCE_COLUMNS}) SELECT ${EVIDENCE_COLUMNS} FROM head.memory_evidence`);
    db.exec('DETACH DATABASE head');
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
  return { dbPath, first, successor };
};

const triggerNames = (db: DatabaseSync): string[] =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
    .all()
    .map((row) => String(row['name']));

const deleteRulesOf = (db: DatabaseSync, table: string): string[] =>
  db
    .prepare(`PRAGMA foreign_key_list(${table})`)
    .all()
    .map((row) => String(row['on_delete']));

const rowsOf = (db: DatabaseSync, table: string, order: string): unknown[] => db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();

describe('migration 39: no trigger and no cascade for the delete of a memory, which the database refuses', () => {
  it('a new database has no memories_index_delete trigger and no cascade from memories', () => {
    const { dbPath } = harness();
    const db = rawDb(dbPath);
    expect(triggerNames(db)).not.toContain('memories_index_delete');
    expect(triggerNames(db)).toContain('memories_reject_delete');
    expect(deleteRulesOf(db, 'memory_replacements')).toEqual(['NO ACTION']);
    expect(deleteRulesOf(db, 'memory_evidence')).toEqual(['NO ACTION']);
  });

  it('a version-38 database loses the trigger and the cascades and keeps every replacement and evidence row', async () => {
    const { dbPath, first, successor } = await versionThirtyEightWithMemories();
    const before = rawDb(dbPath);
    expect(triggerNames(before)).toContain('memories_index_delete');
    expect(deleteRulesOf(before, 'memory_evidence')).toEqual(['CASCADE']);
    const replacements = rowsOf(before, 'memory_replacements', 'replaced_id, successor_id');
    const evidence = rowsOf(before, 'memory_evidence', 'memory_id, ordinal');
    expect(replacements).toEqual([{ replaced_id: first.id, successor_id: successor.id }]);
    expect(evidence).toHaveLength(2);
    before.close();

    const store = openStoreAt(dbPath, createFakeClock(START_MS + 1));
    expect(store.memories.get(successor.id)).toMatchObject({ supersedes: [first.id], evidence: successor.evidence });
    store.close();

    const after = rawDb(dbPath);
    expect(triggerNames(after)).not.toContain('memories_index_delete');
    expect(deleteRulesOf(after, 'memory_replacements')).toEqual(['NO ACTION']);
    expect(deleteRulesOf(after, 'memory_evidence')).toEqual(['NO ACTION']);
    expect(rowsOf(after, 'memory_replacements', 'replaced_id, successor_id')).toEqual(replacements);
    expect(rowsOf(after, 'memory_evidence', 'memory_id, ordinal')).toEqual(evidence);
    expect(
      after
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'memory_replacements_by_successor'")
        .all()
        .map((row) => String(row['name'])),
    ).toEqual(['memory_replacements_by_successor']);
  });

  it('a replacement is still recorded when a memory is saved after the migration', async () => {
    const { dbPath, successor } = await versionThirtyEightWithMemories();
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 1));
    store.close();
    const db = rawDb(dbPath);
    db.prepare("UPDATE memories SET supersedes_json = '[\"m-other\"]' WHERE id = ?").run(successor.id);
    expect(rowsOf(db, 'memory_replacements', 'replaced_id, successor_id')).toEqual([{ replaced_id: 'm-other', successor_id: successor.id }]);
  });

  it('is version 39, the first after 38', () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions.indexOf(39)).toBe(versions.indexOf(38) + 1);
  });
});
