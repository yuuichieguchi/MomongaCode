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
import { LEASE_MS, START_MS, enqueue, harness, makeStoreDir, mustClaim, newSession, openStoreAt, rawDb, registerCleanup, UNASKED_COMMANDS } from './helpers.ts';

const requested = (step: number): RunEventPayload => ({ type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: { model: 'fm', input: [] } }) as RunEventPayload;

const responded = (step: number, target?: string): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
  ...(target === undefined ? {} : { target }),
});

const rejected = (step: number, reason: 'missing_target' | 'missing_usage', target?: string): RunEventPayload => ({
  type: 'model.rejected',
  step,
  attempt: 1,
  reason,
  ...(target === undefined ? {} : { target }),
});

const charged = (purpose: 'compaction' | 'permission_classifier' | 'rejected_answer', target?: string): RunEventPayload => ({
  type: 'usage.charged',
  purpose,
  inputTokens: 3,
  outputTokens: 1,
  totalTokens: 4,
  ...(target === undefined ? {} : { target }),
});

const observed = (target: string): RunEventPayload => ({
  type: 'meter.observed',
  target,
  counter: 'c'.repeat(64),
  fallback: false,
  inputDigest: 'd'.repeat(64),
  itemCount: 1,
  counted: 10,
  reported: 10,
  kept: 10,
  known: 10,
  uncounted: 0,
  miss: 0,
  contextWindow: 8192,
  tokenCounting: 'estimated',
});

const appendedRun = (store: RuntimeStore, events: RunEventPayload[]): string => {
  const session = newSession(store);
  const run = enqueue(store, session.id);
  const claim = mustClaim(store, 'w1');
  expect(store.append(claim, events).kind).toBe('ok');
  return run.id;
};

const tableOf = (dbPath: string, runId: string): string[] =>
  rawDb(dbPath)
    .prepare('SELECT target FROM run_answerers WHERE run_id = ? ORDER BY target')
    .all(runId)
    .map((row) => String(row['target']));

const recorded = async (events: RunEventPayload[]): Promise<{ read: string[]; table: string[] }> => {
  const { store, dbPath } = harness();
  const runId = appendedRun(store, events);
  return { read: await store.answeringTargetsOf(runId), table: tableOf(dbPath, runId) };
};

describe('run_answerers, the per-run record of the targets that answered, written at append', () => {
  it('a fallback run names both targets that answered, once each and sorted', async () => {
    const result = await recorded([requested(1), responded(1, 'primary'), requested(2), responded(2, 'fallback'), requested(3), responded(3, 'primary')]);
    expect(result).toEqual({ read: ['fallback', 'primary'], table: ['fallback', 'primary'] });
  });

  it('a run whose only answer is a compaction charge names the target that answered the compaction', async () => {
    expect(await recorded([charged('compaction', 'scripted')])).toEqual({ read: ['scripted'], table: ['scripted'] });
  });

  it('a permission classifier charge names its target', async () => {
    expect(await recorded([requested(1), responded(1, 'primary'), charged('permission_classifier', 'judge')])).toEqual({ read: ['judge', 'primary'], table: ['judge', 'primary'] });
  });

  it('a wrap-up summary answer, which writes no meter.observed, names its target', async () => {
    expect(await recorded([requested(1), responded(1, 'summarizer')])).toEqual({ read: ['summarizer'], table: ['summarizer'] });
  });

  it('a rejected answer names the target that gave it', async () => {
    expect(await recorded([requested(1), rejected(1, 'missing_usage', 'flaky'), charged('rejected_answer', 'flaky')])).toEqual({ read: ['flaky'], table: ['flaky'] });
  });

  it('a rejected answer that carries no target, as missing_target does, gives unknown and never a shorter list', async () => {
    expect(await recorded([requested(1), responded(1, 'primary'), rejected(2, 'missing_target')])).toEqual({ read: ['primary', 'unknown'], table: ['primary', 'unknown'] });
  });

  it('a charge without a target gives unknown', async () => {
    expect(await recorded([charged('compaction')])).toEqual({ read: ['unknown'], table: ['unknown'] });
  });

  it('meter.observed is not a source: its target alone names nothing', async () => {
    expect(await recorded([observed('metered-only')])).toEqual({ read: [], table: [] });
  });

  it('a run with no paid answer has no answerer, and another run of the store does not leak into it', async () => {
    const { store } = harness();
    const answered = appendedRun(store, [requested(1), responded(1, 'primary')]);
    const quiet = enqueue(store, newSession(store, '/work/b').id);
    expect(await store.answeringTargetsOf(answered)).toEqual(['primary']);
    expect(await store.answeringTargetsOf(quiet.id)).toEqual([]);
  });
});

describe('the migration that adds run_answerers fills it once for runs written before', () => {
  const before = MIGRATIONS.slice(0, MIGRATIONS.findIndex((migration) => JSON.stringify(migration).includes('run_answerers')));

  const legacyDatabase = (runs: Record<string, RunEventPayload[]>): string => {
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    const db = new DatabaseSync(dbPath);
    try {
      migrate(db, before);
      db.prepare('INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s1', '/work/a', '{}', 'default', 'fm', START_MS);
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
    return dbPath;
  };

  it('is a migration of its own, after every migration of a database written before the table', async () => {
    expect(before.length).toBeLessThan(MIGRATIONS.length);
  });

  it('pairs each model.responded with the next meter.observed before the next model.requested, and gives unknown to an old compaction charge', async () => {
    const dbPath = legacyDatabase({
      paired: [requested(1), responded(1), observed('alpha'), requested(2), responded(2), observed('beta'), charged('compaction')],
      exact: [requested(1), responded(1), observed('alpha'), requested(2), responded(2), observed('alpha')],
      quiet: [{ type: 'user.message', text: 'hello' }],
    });
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 10));
    expect(await store.answeringTargetsOf('paired')).toEqual(['alpha', 'beta', 'unknown']);
    expect(await store.answeringTargetsOf('exact')).toEqual(['alpha']);
    expect(await store.answeringTargetsOf('quiet')).toEqual([]);
    expect(tableOf(dbPath, 'paired')).toEqual(['alpha', 'beta', 'unknown']);
  });

  it('a meter.observed after the next model.requested pairs with nothing, so both answers are unknown', async () => {
    const dbPath = legacyDatabase({ crossed: [requested(1), responded(1), requested(2), observed('beta'), responded(2)] });
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 10));
    expect(await store.answeringTargetsOf('crossed')).toEqual(['unknown']);
  });

  it('an old summary answer, a rejected answer and every old charge give unknown', async () => {
    const dbPath = legacyDatabase({
      summary: [requested(1), responded(1)],
      rejected: [requested(1), rejected(1, 'missing_usage'), charged('rejected_answer')],
      classifier: [charged('permission_classifier')],
    });
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 10));
    expect(await store.answeringTargetsOf('summary')).toEqual(['unknown']);
    expect(await store.answeringTargetsOf('rejected')).toEqual(['unknown']);
    expect(await store.answeringTargetsOf('classifier')).toEqual(['unknown']);
  });
});

describe('reading the answerers of a run does not grow with its journal', () => {
  const decodedReading = async (meterEvents: number): Promise<{ targets: string[]; rows: number }> => {
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    let rows = 0;
    const store = openRuntimeStore({ unaskedCommands: UNASKED_COMMANDS,
      path: dbPath,
      home: path.dirname(dbPath),
      clock: createFakeClock(START_MS),
      leaseMs: LEASE_MS,
      maxAttempts: 5,
      maxTotalAttempts: 1000,
      onDecode: (decoded) => {
        rows += decoded;
      },
    });
    registerCleanup(() => store.close());
    const runId = appendedRun(store, [requested(1), responded(1, 'primary'), ...Array.from({ length: meterEvents }, () => observed('primary'))]);
    rows = 0;
    const targets = await store.answeringTargetsOf(runId);
    return { targets, rows };
  };

  it('a run with 10 and a run with 10,000 meter.observed events decode no event to read their answerers', async () => {
    expect(await decodedReading(10)).toEqual({ targets: ['primary'], rows: 0 });
    expect(await decodedReading(10_000)).toEqual({ targets: ['primary'], rows: 0 });
  });
});
