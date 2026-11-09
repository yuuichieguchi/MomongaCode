import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { canonicalJson, migrate } from '@momonga/foundation';
import type { RunEventPayload } from '@momonga/protocol';
import { openRuntimeStore } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { LEASE_MS, START_MS, callEvent, enqueue, makeStoreDir, mustClaim, newSession, openStoreAt, rawDb, registerCleanup } from './helpers.ts';

type Decoded = { rows: number; bytes: number };

type CallSeqStore = RuntimeStore & { toolCallSeq(runId: string, callId: string): number | undefined };

const countingStore = (dbPath: string, decoded: Decoded): CallSeqStore => {
  const store = openRuntimeStore({
    path: dbPath,
    home: path.dirname(dbPath),
    clock: createFakeClock(START_MS),
    leaseMs: LEASE_MS,
    maxAttempts: 5,
    maxTotalAttempts: 1000,
    onDecode: (rows, bytes) => {
      decoded.rows += rows;
      decoded.bytes += bytes;
    },
  });
  registerCleanup(() => store.close());
  return store as CallSeqStore;
};

const bulkyCall = (callId: string): RunEventPayload => ({ ...callEvent(callId), rawInput: { file_path: `/work/a/${callId}.txt`, content: 'x'.repeat(20_000) } });

const permissionRequested = (approvalId: string, callId: string): RunEventPayload => ({
  type: 'tool.permission.requested',
  approvalId,
  callId,
  options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  subjectDigest: `subject-${callId}`,
  reason: 'needs approval',
});

const elicitationRequested = (inputId: string, callId: string): RunEventPayload => ({ type: 'tool.elicitation.requested', inputId, callId, server: 'srv', requests: [] });

const journalWithCalls = (calls: number) => {
  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  const decoded: Decoded = { rows: 0, bytes: 0 };
  const store = countingStore(dbPath, decoded);
  const run = enqueue(store, newSession(store).id, 'do the task');
  const claim = mustClaim(store, 'w1');
  const ids = Array.from({ length: calls }, (_, index) => `c${index + 1}`);
  expect(store.append(claim, ids.map(bulkyCall)).kind).toBe('ok');
  return { dbPath, decoded, store, run, claim, ids };
};

describe('the id a payload carries is a column written at append (row 16), so a lookup by id reads no payload', () => {
  it('copies callId into call_id for tool.call, approvalId into approval_id for a permission request and inputId into approval_id for an elicitation request', async () => {
    const { dbPath, store, claim, run } = journalWithCalls(2);
    expect(store.append(claim, [permissionRequested('a1', 'c1'), elicitationRequested('i1', 'c2')]).kind).toBe('ok');
    const rows = rawDb(dbPath)
      .prepare("SELECT type, call_id, approval_id FROM events WHERE run_id = ? AND type IN ('tool.call', 'tool.permission.requested', 'tool.elicitation.requested') ORDER BY seq")
      .all(run.id);
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { type: 'tool.call', call_id: 'c1', approval_id: null },
      { type: 'tool.call', call_id: 'c2', approval_id: null },
      { type: 'tool.permission.requested', call_id: 'c1', approval_id: 'a1' },
      { type: 'tool.elicitation.requested', call_id: 'c2', approval_id: 'i1' },
    ]);
  });

  it('indexes call_id and approval_id by run, so the lookup does not scan the run', async () => {
    const { dbPath } = journalWithCalls(1);
    const db = rawDb(dbPath);
    const indexed = (db.prepare('PRAGMA index_list(events)').all() as { name: string }[]).map((index) =>
      (db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as { name: string }[]).map((column) => column.name),
    );
    expect(indexed).toContainEqual(expect.arrayContaining(['run_id', 'call_id']));
    expect(indexed).toContainEqual(expect.arrayContaining(['run_id', 'approval_id']));
  });

  it('agrees with the payload for every row it was written for (the column is a fold of the journal)', async () => {
    const { dbPath, store, claim, run } = journalWithCalls(3);
    expect(store.append(claim, [permissionRequested('a1', 'c3')]).kind).toBe('ok');
    const mismatched = rawDb(dbPath)
      .prepare(
        `SELECT seq FROM events WHERE run_id = ? AND (
           (type = 'tool.call' AND call_id IS NOT json_extract(payload_json, '$.callId'))
           OR (type = 'tool.permission.requested' AND approval_id IS NOT json_extract(payload_json, '$.approvalId'))
         )`,
      )
      .all(run.id);
    expect(mismatched).toEqual([]);
  });
});

describe('the seq of a tool call is read from its column (row 7): toolCallSeq', () => {
  it('returns the seq of the tool.call event, and undefined for an unknown call', async () => {
    const { store, run } = journalWithCalls(3);
    const seqs = store.readRunEvents(run.id, 0, 100).filter((event) => event.type === 'tool.call').map((event) => event.seq);
    expect(await store.toolCallSeq(run.id, 'c2')).toBe(seqs[1]);
    expect(await store.toolCallSeq(run.id, 'missing')).toBeUndefined();
  });

  it('decodes no journal payload on the main thread, at 5 calls and at 200 calls alike', async () => {
    for (const calls of [5, 200]) {
      const { store, run, decoded } = journalWithCalls(calls);
      decoded.rows = 0;
      decoded.bytes = 0;
      expect(await store.toolCallSeq(run.id, `c${calls}`)).toBeGreaterThan(0);
      expect(decoded).toEqual({ rows: 0, bytes: 0 });
    }
  });
});

const ANATOMY = {
  estimated: true as const,
  total: 120,
  layers: { system: 10, tools: 20, instructions: 0, skills: 0, governing: 0, memories: 0, summary: 0, workingState: 0, history: { user: 50, assistant: 30, toolCalls: 5, toolOutputs: 5 }, notices: 0 },
  tools: { Write: 20 },
};

const PREFIX = { preservedItems: 3, toolsChanged: false, causes: [] };

const requestedWithAnatomy: RunEventPayload = {
  type: 'model.requested',
  step: 1,
  attempt: 1,
  digest: 'd1',
  body: { model: 'fm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'y'.repeat(30_000) }] }] },
  anatomy: ANATOMY,
  prefix: PREFIX,
};

const respondedWithTiming: RunEventPayload = {
  type: 'model.responded',
  step: 1,
  attempt: 1,
  response: {
    id: 'resp-1',
    status: 'completed',
    output: [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    timing: { firstEventMs: 40, durationMs: 900 },
  },
} as RunEventPayload;

const modelCallRecords = (requestedSeq: number) => [
  { kind: 'requested', seq: requestedSeq, step: 1, attempt: 1, anatomy: ANATOMY, prefix: PREFIX },
  { kind: 'responded', seq: requestedSeq + 1, step: 1, attempt: 1, responseId: 'resp-1', timing: { firstEventMs: 40, durationMs: 900 } },
];

describe('the anatomy, prefix and timing of a model call are read as before, from columns written at append (row 10)', () => {
  it('returns the same records for a run appended today', async () => {
    const { store, claim, run } = journalWithCalls(1);
    const appended = store.append(claim, [requestedWithAnatomy, respondedWithTiming]);
    if (appended.kind !== 'ok') throw new Error('append refused');
    expect(await store.readModelCallEvents(run.id)).toEqual(modelCallRecords(appended.lastSeq - 1));
  });
});

const OLD_PAYLOADS: RunEventPayload[] = [
  { type: 'user.message', text: 'hi' },
  callEvent('c1'),
  permissionRequested('a1', 'c1'),
  callEvent('c2'),
  elicitationRequested('i1', 'c2'),
  requestedWithAnatomy,
  respondedWithTiming,
];

const versionNineteen = (): string => {
  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  const db = new DatabaseSync(dbPath);
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 19));
    db.prepare('INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s1', '/work/a', '{}', 'default', 'fm', START_MS);
    db.prepare(
      `INSERT INTO runs (id, session_id, ordinal, status, version, lease_owner, lease_token, lease_expires_at, available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at)
       VALUES (?, ?, 1, 'RUNNING', 1, 'w1', 1, ?, ?, 1, 0, 0, ?, '{}', ?, 1, 7, '{}', 0, ?)`,
    ).run('r1', 's1', START_MS + 1_000_000, START_MS, START_MS + 3_600_000, canonicalJson({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), START_MS);
    const insertEvent = db.prepare('INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json) VALUES (?, ?, ?, 1, 1, ?, ?, ?)');
    OLD_PAYLOADS.forEach((payload, index) => insertEvent.run('r1', 's1', index + 1, START_MS, payload.type, canonicalJson(payload)));
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
  return dbPath;
};

describe('an upgrade from version 19 over journals written before the columns', () => {
  it('fills call_id and approval_id of every old row once, so old runs are looked up by column too', async () => {
    const dbPath = versionNineteen();
    openStoreAt(dbPath, createFakeClock(START_MS + 10)).close();
    const db = rawDb(dbPath);
    expect(db.prepare('SELECT seq, call_id, approval_id FROM events WHERE run_id = ? ORDER BY seq').all('r1').map((row) => ({ ...row }))).toEqual([
      { seq: 1, call_id: null, approval_id: null },
      { seq: 2, call_id: 'c1', approval_id: null },
      { seq: 3, call_id: 'c1', approval_id: 'a1' },
      { seq: 4, call_id: 'c2', approval_id: null },
      { seq: 5, call_id: 'c2', approval_id: 'i1' },
      { seq: 6, call_id: null, approval_id: null },
      { seq: 7, call_id: null, approval_id: null },
    ]);
    expect((db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version).toBeGreaterThan(19);
  });

  it('answers toolCallSeq for an old run from the filled column', async () => {
    const dbPath = versionNineteen();
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 10)) as CallSeqStore;
    expect(await store.toolCallSeq('r1', 'c2')).toBe(4);
  });

  it('still reads the anatomy, prefix and timing of an old run (row 10) and its called names (row 8b)', async () => {
    const store = openStoreAt(versionNineteen(), createFakeClock(START_MS + 10));
    expect(await store.readModelCallEvents('r1')).toEqual(modelCallRecords(6));
    expect(await store.toolCallNames('r1')).toEqual(['Write']);
  });
});
