import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { canonicalJson, migrate } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { DEADLINE_MS, START_MS, cancel, harness, makeStoreDir, mustRun, openStoreAt, payloadOf, rawDb } from './helpers.ts';
import { EXPIRES_MS, OPTIONS, awaitingApproval } from './approval-fixture.ts';

const THIRTY_MINUTES_MS = 30 * 60_000;
const SWEEP_TIMES = [EXPIRES_MS, START_MS + THIRTY_MINUTES_MS, START_MS + THIRTY_MINUTES_MS + 1, DEADLINE_MS - 1];
const rethrow = (error: unknown): never => {
  throw error;
};

const rowCounts = (dbPath: string, runId: string): { approvals: number; events: number } => {
  const db = rawDb(dbPath);
  return {
    approvals: Number(db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?').get(runId)?.['n']),
    events: Number(db.prepare('SELECT COUNT(*) AS n FROM events WHERE run_id = ?').get(runId)?.['n']),
  };
};

describe('a permission approval has no expiry of its own', () => {
  it('stores no expiry on the row and shows none on the view', async () => {
    const { dbPath, store } = harness();
    const { runId, approvals } = await awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    const [approval] = approvals;
    if (approval === undefined) throw new Error('expected an approval');

    expect(approval).not.toHaveProperty('expiresAt');
    expect(await store.approvalView(approval.id)).not.toHaveProperty('expiresAt');
    expect(rawDb(dbPath).prepare('SELECT expires_at FROM approvals WHERE id = ?').get(approval.id)).toEqual({ expires_at: null });
    expect((await store.pendingApprovalViews(runId)).map((view) => view.id)).toEqual([approval.id]);
  });

  it('refuses a permission row that carries an expiry', async () => {
    const { dbPath, store } = harness();
    const { runId } = await awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    expect(() =>
      rawDb(dbPath)
        .prepare(
          `INSERT INTO approvals (id, run_id, call_id, status, options_json, expires_at, created_at, kind)
           VALUES ('appr-timed', ?, 'call_2', 'pending', ?, ?, ?, 'permission')`,
        )
        .run(runId, JSON.stringify(OPTIONS), EXPIRES_MS, START_MS),
    ).toThrow(/CHECK/);
  });

  it('stays pending through every sweep before the run ends, and the sweeps write nothing', async () => {
    const { clock, dbPath, store } = harness();
    const { runId, approvals } = await awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    const [approval] = approvals;
    if (approval === undefined) throw new Error('expected an approval');
    const before = { run: mustRun(store, runId), rows: rowCounts(dbPath, runId) };

    for (const at of SWEEP_TIMES) {
      clock.set(at);
      expect(await store.expireApprovals(at, rethrow)).toEqual([]);
    }

    expect(store.approvals.get(approval.id)?.status).toBe('pending');
    expect(mustRun(store, runId)).toMatchObject({ status: 'WAITING_HUMAN', version: before.run.version, lastSeq: before.run.lastSeq });
    expect(rowCounts(dbPath, runId)).toEqual(before.rows);
  });

  it('ends when the person answers, however late before the run ends', async () => {
    const { clock, store } = harness();
    const { runId, approvals } = await awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    clock.set(DEADLINE_MS - 1);

    expect(await store.resolveApproval(approvals[0]?.id ?? '', 'allow_once')).toMatchObject({ kind: 'ok', approval: { status: 'resolved' }, run: { id: runId, status: 'QUEUED' } });
  });

  it('ends when the person cancels the run, withdrawn', async () => {
    const { clock, store } = harness();
    const { runId, approvals } = await awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    clock.set(DEADLINE_MS - 1);

    await cancel(store, runId);

    expect(store.approvals.get(approvals[0]?.id ?? '')?.status).toBe('withdrawn');
    expect(store.readRunEvents(runId, 0, 100).map(payloadOf)).toContainEqual({ type: 'tool.permission.cancelled', approvalId: approvals[0]?.id, reason: 'withdrawn' });
  });

  it('ends when the run reaches its deadline: the run stops with timeout, never approval_timeout, and the approval is withdrawn', async () => {
    const { store } = harness();
    const { runId, approvals } = await awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');

    expect(await store.expireApprovals(DEADLINE_MS, rethrow)).toEqual([runId]);

    expect(mustRun(store, runId)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
    expect(store.approvals.get(approvals[0]?.id ?? '')?.status).toBe('withdrawn');
    const events = store.readRunEvents(runId, 0, 100).map(payloadOf);
    expect(events.filter((event) => event['type'] === 'notice' && event['code'] === 'approval_expired')).toEqual([]);
    expect(events.filter((event) => event['type'] === 'tool.permission.cancelled')).toEqual([{ type: 'tool.permission.cancelled', approvalId: approvals[0]?.id, reason: 'withdrawn' }]);
  });
});

const versionTwentySix = (): string => {
  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  const db = new DatabaseSync(dbPath);
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 26));
    db.prepare('INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s1', '/work/a', '{}', 'default', 'fm', START_MS);
    db.prepare(
      `INSERT INTO runs (id, session_id, ordinal, status, version, lease_owner, lease_token, lease_expires_at, available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at)
       VALUES ('r1', 's1', 1, 'WAITING_HUMAN', 1, NULL, 1, NULL, ?, 1, 0, 0, ?, '{}', ?, 1, 0, '{}', 0, ?)`,
    ).run(START_MS, DEADLINE_MS, canonicalJson({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), START_MS);
    const insert = db.prepare(
      `INSERT INTO approvals (id, run_id, call_id, status, options_json, option_id, expires_at, created_at, resolved_at, subject_digest, kind, server, requests_json)
       VALUES (?, 'r1', ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?)`,
    );
    insert.run('appr-pending', 'call_1', 'pending', JSON.stringify(OPTIONS), EXPIRES_MS, START_MS, 'permission', null, null);
    insert.run('appr-expired', 'call_2', 'expired', JSON.stringify(OPTIONS), START_MS + 10, START_MS, 'permission', null, null);
    insert.run('input-1', 'call_3', 'resolved', '[]', EXPIRES_MS + 5, START_MS, 'elicitation', 'remote', '[]');
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
  return dbPath;
};

describe('migration 27 over a version-26 database', () => {
  it('drops the expiry of every permission row, keeps its status, and keeps the expiry of every request for input', async () => {
    const dbPath = versionTwentySix();
    const store = openStoreAt(dbPath, createFakeClock(EXPIRES_MS + 1));
    try {
      const rows = rawDb(dbPath).prepare('SELECT id, status, kind, expires_at FROM approvals ORDER BY id').all();
      expect(rows).toEqual([
        { id: 'appr-expired', status: 'expired', kind: 'permission', expires_at: null },
        { id: 'appr-pending', status: 'pending', kind: 'permission', expires_at: null },
        { id: 'input-1', status: 'resolved', kind: 'elicitation', expires_at: EXPIRES_MS + 5 },
      ]);
      expect(await store.expireApprovals(EXPIRES_MS + 1, rethrow)).toEqual([]);
      expect(store.approvals.get('appr-pending')?.status).toBe('pending');
      expect(rawDb(dbPath).prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 29 });
    } finally {
      store.close();
    }
  });
});
