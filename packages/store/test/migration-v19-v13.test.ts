import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, makeStoreDir, mustRun, openStoreAt, rawDb } from './helpers.ts';

type LegacyRun = {
  id: string;
  sessionId: string;
  ordinal: number;
  status: string;
  held: boolean;
  cancelledFrom?: string;
};

const buildMainDatabase = (sessions: Readonly<Record<string, string>>, runs: readonly LegacyRun[], trust: Readonly<Record<string, string>> = {}): string => {
  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  const db = new DatabaseSync(dbPath);
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 5));
    for (const [trustedPath, decision] of Object.entries(trust)) {
      db.prepare('INSERT INTO trust (path, decision, decided_at) VALUES (?, ?, ?)').run(trustedPath, decision, START_MS);
    }
    for (const [sessionId, cwd] of Object.entries(sessions)) {
      db.prepare(
        `INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at)
         VALUES (?, ?, '{"PATH":"/usr/bin"}', 'default', 'fm', ?)`,
      ).run(sessionId, cwd, START_MS);
    }
    const insertRun = db.prepare(
      `INSERT INTO runs (id, session_id, ordinal, idempotency_key, request_digest, previous_run_id, status, stop_reason, version, lease_owner,
         lease_token, lease_expires_at, available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step,
         last_seq, pins, error_json, dead_letter, created_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, NULL, 1, ?, 1, ?, ?, 1, 0, ?, ?, '{}', '{"inputTokens":0,"outputTokens":0,"totalTokens":0}', 0,
         1, '{}', NULL, 0, ?)`,
    );
    const insertEvent = db.prepare(
      `INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json) VALUES (?, ?, ?, 0, 1, ?, ?, ?)`,
    );
    for (const run of runs) {
      const cancelling = run.status === 'CANCELLING';
      insertRun.run(
        run.id,
        run.sessionId,
        run.ordinal,
        run.status,
        run.held ? 'w0' : null,
        run.held ? START_MS + 1000 : null,
        START_MS,
        cancelling ? 1 : 0,
        START_MS + 3_600_000,
        START_MS,
      );
      insertEvent.run(run.id, run.sessionId, 1, START_MS, 'user.message', '{"text":"hello","type":"user.message"}');
      if (run.cancelledFrom !== undefined) {
        const payload = JSON.stringify({ type: 'run.status', from: run.cancelledFrom, to: 'CANCELLING' });
        insertEvent.run(run.id, run.sessionId, 2, START_MS, 'run.status', payload);
        db.prepare('UPDATE runs SET last_seq = 2 WHERE id = ?').run(run.id);
      }
    }
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
  return dbPath;
};

const originsOf = (dbPath: string, column: 'cancel_origin' | 'origin'): Record<string, unknown> =>
  Object.fromEntries(rawDb(dbPath).prepare(`SELECT id, ${column} AS value FROM runs ORDER BY id`).all().map((row) => [row['id'], row['value']]));

describe('migration 19 on a database written by main', () => {
  const SESSIONS = { a: '/work/a', b: '/work/b', c: '/work/c' };
  const RUNS: readonly LegacyRun[] = [
    { id: 'a1', sessionId: 'a', ordinal: 1, status: 'COMPLETED', held: false },
    { id: 'a2', sessionId: 'a', ordinal: 2, status: 'CANCELLING', held: true, cancelledFrom: 'RUNNING' },
    { id: 'a3', sessionId: 'a', ordinal: 3, status: 'QUEUED', held: false },
    { id: 'b1', sessionId: 'b', ordinal: 1, status: 'CANCELLING', held: true, cancelledFrom: 'WAITING_TOOL' },
    { id: 'b2', sessionId: 'b', ordinal: 2, status: 'QUEUED', held: false },
    { id: 'c1', sessionId: 'c', ordinal: 1, status: 'CANCELLING', held: false },
    { id: 'c2', sessionId: 'c', ordinal: 2, status: 'QUEUED', held: false },
  ];

  it('derives the cancel origin of a CANCELLING run from its journal and gives a run without that record the origin of the worker-owned path', () => {
    const dbPath = buildMainDatabase(SESSIONS, RUNS);
    openStoreAt(dbPath, createFakeClock(START_MS + 10_000)).close();

    expect(originsOf(dbPath, 'cancel_origin')).toEqual({
      a1: null,
      a2: 'RUNNING',
      a3: null,
      b1: 'WAITING_TOOL',
      b2: null,
      c1: 'RUNNING',
      c2: null,
    });
  });

  it('lets a worker claim and finish every run that was CANCELLING at the upgrade, so the queued run behind it runs', async () => {
    const dbPath = buildMainDatabase(SESSIONS, RUNS);
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 10_000));

    const claimed: string[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const claim = store.claim('w9');
      if (claim === null) break;
      claimed.push(claim.runId);
      if (claim.status === 'CANCELLING') {
        const ended = await store.transition(claim, ['CANCELLING'], 'CANCELLED');
        expect(ended.kind).toBe('ok');
      }
    }

    expect(claimed.sort()).toEqual(['a2', 'a3', 'b1', 'b2', 'c1', 'c2']);
    expect(mustRun(store, 'a2').status).toBe('CANCELLED');
  });

  it('refuses a CANCELLING run without a cancel origin, whether inserted or updated', () => {
    const dbPath = buildMainDatabase(SESSIONS, RUNS);
    openStoreAt(dbPath, createFakeClock(START_MS + 10_000)).close();
    const db = rawDb(dbPath);

    expect(() => db.prepare("UPDATE runs SET cancel_origin = NULL WHERE id = 'a2'").run()).toThrow(/cancel origin/);
    expect(() => db.prepare("UPDATE runs SET status = 'CANCELLING' WHERE id = 'a3'").run()).toThrow(/cancel origin/);
    expect(() => db.prepare("UPDATE runs SET status = 'CANCELLING', cancel_origin = 'QUEUED' WHERE id = 'a3'").run()).not.toThrow();
  });
});

describe('migration 13 on a database written by main', () => {
  it('gives each existing run the origin that the nearest trust decision of its session folder gives, as migration 10 gives memories', () => {
    const sessions = {
      'in-trusted': '/work/trusted',
      'below-trusted': '/work/trusted/sub',
      'sibling-prefix': '/work/trusted-other',
      refused: '/work/refused',
      unknown: '/work/unknown',
      'refused-below-trusted': '/work/trusted/refused-below/sub',
    };
    const runs: readonly LegacyRun[] = Object.keys(sessions).map((sessionId) => ({
      id: `run-${sessionId}`,
      sessionId,
      ordinal: 1,
      status: 'COMPLETED',
      held: false,
    }));
    const dbPath = buildMainDatabase(sessions, runs, {
      '/work/trusted': 'trusted',
      '/work/refused': 'untrusted',
      '/work/trusted/refused-below': 'untrusted',
    });

    openStoreAt(dbPath, createFakeClock(START_MS + 1)).close();

    expect(originsOf(dbPath, 'origin')).toEqual({
      'run-in-trusted': 'trusted',
      'run-below-trusted': 'trusted',
      'run-sibling-prefix': 'untrusted',
      'run-refused': 'untrusted',
      'run-unknown': 'untrusted',
      'run-refused-below-trusted': 'untrusted',
    });
  });
});
