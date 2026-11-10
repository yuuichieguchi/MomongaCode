import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { canonicalJson, migrate } from '@momonga/foundation';
import type { RunEventPayload } from '@momonga/protocol';
import { createFakeClock } from '@momonga/testkit';
import { INDEXED_CHARS_DERIVATION } from '../src/append-records.ts';
import { DERIVATIONS } from '../src/derived-repair.ts';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, enqueue, harness, makeStoreDir, mustClaim, newSession, openStoreAt, rawDb } from './helpers.ts';
import { finishedRun, redactor } from './search-fixture.ts';

const PROBE = `SELECT COALESCE(SUM(length(payload_json)), 0) AS chars FROM events WHERE run_id = ? AND type IN ('user.message', 'model.responded', 'tool.call', 'tool.completed')`;

const scannedChars = (dbPath: string, runId: string): number => Number(rawDb(dbPath).prepare(PROBE).get(runId)?.['chars']);

const recordedChars = (dbPath: string, runId: string): number | undefined => {
  const row = rawDb(dbPath).prepare('SELECT chars FROM run_indexed_chars WHERE run_id = ?').get(runId);
  return row === undefined ? undefined : Number(row['chars']);
};

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

const mixed: RunEventPayload[] = [
  { type: 'run.started', attempt: 1, now: START_MS, pins: {}, mode: 'manual' },
  { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { model: 'fm', input: ['not indexed '.repeat(500)] } },
  { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [], usage } },
  { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Read', kind: 'read', title: 'Read 設定', rawInput: { file_path: '/work/a/設定.ts' } },
  { type: 'tool.completed', callId: 'c1', status: 'completed', output: `ascii 設定ファイルの読み込み ${'𝒜😀'.repeat(40)} "quoted"\n` },
  { type: 'notice', level: 'info', message: 'not indexed' },
];

describe('run_indexed_chars, the characters of the indexed events of a run, added up at append (row 12, O9)', () => {
  it('is its own derivation among the records filled at append', () => {
    expect(DERIVATIONS).toContain(INDEXED_CHARS_DERIVATION);
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions.indexOf(INDEXED_CHARS_DERIVATION)).toBe(versions.indexOf(34) + 1);
    expect(Math.max(...versions)).toBe(INDEXED_CHARS_DERIVATION);
  });

  it('equals what the scan of the payloads of the indexed types gives, for ASCII, Japanese, astral characters and escapes, and counts no other event type', () => {
    const { store, dbPath } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');

    expect(store.append(claim, mixed.slice(0, 3)).kind).toBe('ok');
    expect(recordedChars(dbPath, run.id)).toBe(scannedChars(dbPath, run.id));
    expect(store.append(claim, mixed.slice(3)).kind).toBe('ok');

    expect(recordedChars(dbPath, run.id)).toBe(scannedChars(dbPath, run.id));
    expect(scannedChars(dbPath, run.id)).toBeGreaterThan(0);
  });

  it('keeps the totals of two runs apart', async () => {
    const { store, dbPath } = harness();
    const small = await finishedRun(store, '/work/a', 'small', [{ text: 'said' }]);
    const large = await finishedRun(store, '/work/a', 'large', [{ tool: { name: 'Read', path: '/work/a/f.ts', output: 'recorded '.repeat(300) } }]);

    expect(recordedChars(dbPath, small.id)).toBe(scannedChars(dbPath, small.id));
    expect(recordedChars(dbPath, large.id)).toBe(scannedChars(dbPath, large.id));
    expect(recordedChars(dbPath, large.id)).toBeGreaterThan(recordedChars(dbPath, small.id) ?? 0);
  });
});

describe('the indexing batch reads the total of a run from the record, not from its payloads', () => {
  it('takes a second run only when the recorded totals fit the budget, as the scan decided before', async () => {
    const { store, dbPath } = harness();
    const first = await finishedRun(store, '/work/a', 'one', [{ tool: { name: 'Read', path: '/work/a/f.ts', output: 'x'.repeat(2000) } }]);
    const second = await finishedRun(store, '/work/a', 'two', [{ tool: { name: 'Read', path: '/work/a/f.ts', output: 'y'.repeat(2000) } }]);
    const both = scannedChars(dbPath, first.id) + scannedChars(dbPath, second.id);

    expect(await store.search.indexBatch({ limit: 10, redactor, maxChars: both - 1 })).toEqual({ runs: 1 });
    expect(await store.search.indexBatch({ limit: 10, redactor, maxChars: both - 1 })).toEqual({ runs: 1 });
  });

  it('decides by the record alone: a record made larger than the payloads keeps the run out of a batch its payloads would fit', async () => {
    const { store, dbPath } = harness();
    await finishedRun(store, '/work/a', 'one', [{ text: 'said' }]);
    const second = await finishedRun(store, '/work/a', 'two', [{ text: 'said' }]);
    rawDb(dbPath).prepare('UPDATE run_indexed_chars SET chars = 1000000 WHERE run_id = ?').run(second.id);

    expect(await store.search.indexBatch({ limit: 10, redactor, maxChars: 100_000 })).toEqual({ runs: 1 });
  });

  it('repairs the record of a run whose watermark is behind its events before it decides, in pages, and then indexes it', async () => {
    const { store, dbPath } = harness();
    await finishedRun(store, '/work/a', 'one', [{ text: 'said' }]);
    const second = await finishedRun(store, '/work/a', 'two', [{ tool: { name: 'Read', path: '/work/a/f.ts', output: 'z'.repeat(3000) } }]);
    const exact = scannedChars(dbPath, second.id);
    const db = rawDb(dbPath);
    db.prepare('DELETE FROM run_indexed_chars WHERE run_id = ?').run(second.id);
    db.prepare('UPDATE derived_through SET through_seq = 0 WHERE run_id = ? AND derivation = ?').run(second.id, INDEXED_CHARS_DERIVATION);

    expect(await store.search.indexBatch({ limit: 10, redactor, maxChars: exact })).toEqual({ runs: 1 });
    expect(await store.search.indexBatch({ limit: 10, redactor, maxChars: exact })).toEqual({ runs: 1 });
    expect(recordedChars(dbPath, second.id)).toBe(exact);
  });
});

describe('the migration that adds run_indexed_chars fills it once for runs written before', () => {
  const before = MIGRATIONS.filter((migration) => migration.version < INDEXED_CHARS_DERIVATION);

  it('gives every earlier run the total of its indexed events and a watermark at its last seq, and no row to a run with no indexed event', () => {
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    const db = new DatabaseSync(dbPath);
    const runs: Record<string, RunEventPayload[]> = { busy: mixed, quiet: [{ type: 'notice', level: 'info', message: 'nothing indexed' }] };
    try {
      migrate(db, before);
      db.prepare('INSERT INTO sessions (id, cwd, env_json, permission_mode, model, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s1', '/work/a', '{}', 'manual', 'fm', START_MS);
      const insertRun = db.prepare(
        `INSERT INTO runs (id, session_id, ordinal, status, version, lease_owner, lease_token, lease_expires_at, available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at)
         VALUES (?, 's1', ?, 'COMPLETED', 1, NULL, 1, NULL, ?, 1, 0, 0, ?, '{}', ?, 1, ?, '{}', 0, ?)`,
      );
      const insertEvent = db.prepare('INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json) VALUES (?, ?, ?, 1, 1, ?, ?, ?)');
      Object.entries(runs).forEach(([runId, events], ordinal) => {
        insertRun.run(runId, ordinal + 1, START_MS, START_MS + 3_600_000, canonicalJson({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), events.length, START_MS);
        events.forEach((payload, index) => insertEvent.run(runId, 's1', index + 1, START_MS, payload.type, canonicalJson(payload)));
      });
    } finally {
      db.close();
    }
    fs.chmodSync(dbPath, 0o600);

    openStoreAt(dbPath, createFakeClock(START_MS + 10));

    expect(recordedChars(dbPath, 'busy')).toBe(scannedChars(dbPath, 'busy'));
    expect(scannedChars(dbPath, 'busy')).toBeGreaterThan(0);
    expect(recordedChars(dbPath, 'quiet')).toBeUndefined();
    const marks = rawDb(dbPath).prepare('SELECT run_id, through_seq FROM derived_through WHERE derivation = ? ORDER BY run_id').all(INDEXED_CHARS_DERIVATION);
    expect(marks.map((row) => [row['run_id'], Number(row['through_seq'])])).toEqual([['busy', mixed.length], ['quiet', 1]]);
  });
});
