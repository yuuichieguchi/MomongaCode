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
import { LEASE_MS, START_MS, enqueue, makeStoreDir, mustClaim, newSession, openStoreAt, rawDb, registerCleanup } from './helpers.ts';

const USAGE = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };

const requested = (step: number): RunEventPayload => ({ type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: { model: 'fm', input: [] } }) as RunEventPayload;

const responded = (step: number, target?: string): RunEventPayload =>
  ({
    type: 'model.responded',
    step,
    attempt: 1,
    response: { status: 'completed', output: [{ type: 'message', id: `m${step}`, role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: USAGE },
    ...(target === undefined ? {} : { target }),
  }) as RunEventPayload;

const rejected = (step: number, target?: string): RunEventPayload =>
  ({ type: 'model.rejected', step, attempt: 1, reason: 'counter_mismatch', ...(target === undefined ? {} : { target }) }) as RunEventPayload;

const charged = (purpose: 'compaction' | 'permission_classifier' | 'rejected_answer', target?: string): RunEventPayload =>
  ({ type: 'usage.charged', purpose, inputTokens: 1, outputTokens: 1, totalTokens: 2, ...(target === undefined ? {} : { target }) }) as RunEventPayload;

const observed = (target: string): RunEventPayload =>
  ({ type: 'meter.observed', target, counter: 'c', fallback: false, inputDigest: 'i', itemCount: 1, counted: 1, reported: 1, kept: 1, known: 1, uncounted: 0, miss: 0, contextWindow: 100_000, tokenCounting: 'exact' }) as RunEventPayload;

type Opened = { store: RuntimeStore; dbPath: string; decoded: { rows: number } };

const opened = (): Opened => {
  const dir = makeStoreDir();
  const dbPath = path.join(dir, 'runtime.db');
  const decoded = { rows: 0 };
  const store = openRuntimeStore({
    path: dbPath,
    home: dir,
    clock: createFakeClock(START_MS),
    leaseMs: LEASE_MS,
    maxAttempts: 5,
    maxTotalAttempts: 1000,
    onDecode: (rows: number) => {
      decoded.rows += rows;
    },
  });
  registerCleanup(() => store.close());
  return { store, dbPath, decoded };
};

const runWith = (env: Opened, events: readonly RunEventPayload[]): string => {
  const session = newSession(env.store);
  const run = enqueue(env.store, session.id, 'question');
  const claim = mustClaim(env.store, 'w1');
  const appended = env.store.append(claim, [{ type: 'run.started', attempt: claim.attempt, now: 0, pins: { modelAlias: 'fm' } }, ...events] as RunEventPayload[]);
  if (appended.kind !== 'ok') throw new Error(`append failed: ${appended.kind}`);
  return run.id;
};

const tableRows = (dbPath: string, runId: string): string[] =>
  rawDb(dbPath)
    .prepare('SELECT target FROM run_answerers WHERE run_id = ? ORDER BY target')
    .all(runId)
    .map((row) => String(row['target']));

describe('the run_answerers record is written at append from every paid answer (decision 38 A, D17 section 7)', () => {
  it('records the target of model.responded, model.rejected and usage.charged of every purpose, once each, sorted', () => {
    const env = opened();
    const runId = runWith(env, [
      requested(1),
      responded(1, 'primary'),
      requested(2),
      responded(2, 'primary'),
      rejected(3, 'fallback'),
      charged('compaction', 'summariser'),
      charged('permission_classifier', 'classifier'),
      charged('rejected_answer', 'fallback'),
    ]);
    expect(env.store.answeringTargetsOf(runId)).toEqual(['classifier', 'fallback', 'primary', 'summariser']);
    expect(tableRows(env.dbPath, runId)).toEqual(['classifier', 'fallback', 'primary', 'summariser']);
  });

  it('shows a target that answered only a compaction', () => {
    const env = opened();
    const runId = runWith(env, [requested(1), responded(1, 'primary'), charged('compaction', 'scripted-summariser')]);
    expect(env.store.answeringTargetsOf(runId)).toEqual(['primary', 'scripted-summariser']);
  });

  it('records the reserved target unknown for a paid answer that carries no target', () => {
    const env = opened();
    const runId = runWith(env, [requested(1), responded(1, 'primary'), charged('compaction')]);
    expect(env.store.answeringTargetsOf(runId)).toEqual(['primary', 'unknown']);
  });

  it('does not take meter.observed as a source of the record', () => {
    const env = opened();
    const runId = runWith(env, [requested(1), responded(1, 'primary'), observed('observed-only')]);
    expect(env.store.answeringTargetsOf(runId)).toEqual(['primary']);
  });

  it('keeps the targets of each run apart', () => {
    const env = opened();
    const first = runWith(env, [requested(1), responded(1, 'a')]);
    const second = runWith(env, [requested(1), responded(1, 'b')]);
    expect(env.store.answeringTargetsOf(first)).toEqual(['a']);
    expect(env.store.answeringTargetsOf(second)).toEqual(['b']);
  });

  it.each([10, 10_000])('answers a run of %i answers without decoding any event', (count) => {
    const env = opened();
    const events = Array.from({ length: count }, (_unused, index) => [requested(index + 1), responded(index + 1, index % 2 === 0 ? 'even' : 'odd'), observed(index % 2 === 0 ? 'even' : 'odd')]).flat();
    const runId = runWith(env, events);
    const before = env.decoded.rows;
    expect(env.store.answeringTargetsOf(runId)).toEqual(['even', 'odd']);
    expect(env.decoded.rows - before).toBe(0);
  });
});

const LAST_VERSION_WITHOUT_ANSWERERS = 23;

const oldDatabase = (payloads: readonly RunEventPayload[]): string => {
  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  const db = new DatabaseSync(dbPath);
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= LAST_VERSION_WITHOUT_ANSWERERS));
    db.prepare('INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s1', '/work/a', '{}', 'default', 'fm', START_MS);
    db.prepare(
      `INSERT INTO runs (id, session_id, ordinal, status, version, lease_owner, lease_token, lease_expires_at, available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at)
       VALUES (?, ?, 1, 'COMPLETED', 1, NULL, 1, NULL, ?, 1, 0, 0, ?, '{}', ?, 2, ?, '{}', 0, ?)`,
    ).run('r1', 's1', START_MS, START_MS + 3_600_000, canonicalJson({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), payloads.length, START_MS);
    const insertEvent = db.prepare('INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json) VALUES (?, ?, ?, ?, 1, ?, ?, ?)');
    payloads.forEach((payload, index) => insertEvent.run('r1', 's1', index + 1, 'step' in payload ? payload.step : 0, START_MS, payload.type, canonicalJson(payload)));
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
  return dbPath;
};

describe('the one-time backfill of run_answerers for runs written before the record (decision 38 A)', () => {
  it('pairs a model.responded with the next meter.observed above it and below the next model.requested', () => {
    const dbPath = oldDatabase([requested(1), responded(1), observed('first'), requested(2), responded(2), observed('second')]);
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 10));
    expect(store.answeringTargetsOf('r1')).toEqual(['first', 'second']);
  });

  it('records unknown for a model.responded with no paired meter.observed, and never a shorter list', () => {
    const dbPath = oldDatabase([requested(1), responded(1), requested(2), observed('late'), responded(2)]);
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 10));
    expect(store.answeringTargetsOf('r1')).toEqual(['unknown']);
  });

  it('records unknown for an old compaction charge and an old rejected answer', () => {
    const dbPath = oldDatabase([requested(1), responded(1), observed('primary'), charged('compaction'), rejected(2)]);
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 10));
    expect(store.answeringTargetsOf('r1')).toEqual(['primary', 'unknown']);
  });
});
