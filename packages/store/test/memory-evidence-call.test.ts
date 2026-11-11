import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { RUN_API_SCHEMAS } from '@momonga/protocol';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, callEvent, enqueue, harness, makeStoreDir, mustClaim, newSession, openStoreAt, rawDb } from './helpers.ts';

const PROJECT = '/work/a';
const CHECK = { kind: 'check', runId: 'r1', conditionId: 'cond-1', seq: 3, command: 'npm test', exitCode: 0 } as const;
const OLD_COLUMNS = 'memory_id, ordinal, kind, project, path, sha256, sha, run_id, call_id, seq, command, exit_code';

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
addFormats.default(ajv);

const savedWithCheck = async () => {
  const env = harness();
  const run = await enqueue(env.store, newSession(env.store, PROJECT).id);
  const claim = mustClaim(env.store, 'w1');
  expect(env.store.append(claim, [callEvent('c1')]).kind).toBe('ok');
  const { memory } = await env.store.memories.save({ origin: 'trusted', scope: 'project', project: PROJECT, text: 'the tests pass', runId: run.id, step: 1, callId: 'c1', evidence: [CHECK] });
  return { ...env, memory };
};

const versionFortyWithOldCheck = async () => {
  const source = await savedWithCheck();
  source.store.close();
  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  const db = new DatabaseSync(dbPath);
  migrate(db, MIGRATIONS.filter((migration) => migration.version <= 40));
  db.exec(`ATTACH DATABASE '${source.dbPath}' AS head`);
  db.exec('INSERT INTO memories SELECT * FROM head.memories ORDER BY created_at, id');
  db.prepare(
    `INSERT INTO memory_evidence (${OLD_COLUMNS}) VALUES (?, 0, 'check', NULL, NULL, NULL, NULL, 'r0', 'model-call-7', 2, 'npm run lint', 1)`,
  ).run(source.memory.id);
  db.exec('DETACH DATABASE head');
  db.close();
  fs.chmodSync(dbPath, 0o600);
  return { dbPath, id: source.memory.id };
};

describe('the call of a check in the evidence of a memory holds one meaning', () => {
  it('stores a new check with its condition id in condition_id, and leaves call_id empty', async () => {
    const { store, dbPath, memory } = await savedWithCheck();

    expect(store.memories.get(memory.id)?.evidence).toEqual([CHECK]);
    expect(rawDb(dbPath).prepare('SELECT call_id, condition_id FROM memory_evidence WHERE memory_id = ?').all(memory.id)).toEqual([{ call_id: null, condition_id: 'cond-1' }]);
  });

  it('keeps a row an older build wrote and reads its call_id as a reference to a model call', async () => {
    const { dbPath, id } = await versionFortyWithOldCheck();

    const store = openStoreAt(dbPath, createFakeClock(START_MS));

    const evidence = store.memories.get(id)?.evidence;
    expect(evidence).toEqual([{ kind: 'check', runId: 'r0', modelCallId: 'model-call-7', seq: 2, command: 'npm run lint', exitCode: 1 }]);
    expect(rawDb(dbPath).prepare('SELECT call_id, condition_id FROM memory_evidence WHERE memory_id = ?').all(id)).toEqual([{ call_id: 'model-call-7', condition_id: null }]);
  });

  it('shows both forms in the public view of a memory', async () => {
    const validate = ajv.compile(RUN_API_SCHEMAS.MemoryView);
    const { store, memory } = await savedWithCheck();
    const view = { ...store.memories.get(memory.id), status: 'unbound', evidence: [CHECK, { kind: 'check', runId: 'r0', modelCallId: 'model-call-7', seq: 2, command: 'npm run lint', exitCode: 1 }] };

    expect(validate(view), JSON.stringify(validate.errors)).toBe(true);
  });

  it('refuses a check row that holds both columns or neither', async () => {
    const { dbPath, memory } = await savedWithCheck();
    const db = rawDb(dbPath);
    const insert = (callId: string | null, conditionId: string | null) =>
      db
        .prepare("INSERT INTO memory_evidence (memory_id, ordinal, kind, run_id, call_id, condition_id, seq, command, exit_code) VALUES (?, ?, 'check', 'r1', ?, ?, 1, 'x', 0)")
        .run(memory.id, callId === null ? 7 : 8, callId, conditionId);

    expect(() => insert('call', 'cond')).toThrow(/CHECK constraint/);
    expect(() => insert(null, null)).toThrow(/CHECK constraint/);
  });
});
