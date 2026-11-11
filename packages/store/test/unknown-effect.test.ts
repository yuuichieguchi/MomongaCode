import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { canonicalJson, migrate } from '@momonga/foundation';
import { UNKNOWN_EFFECT_ADVICE, UNKNOWN_EFFECT_REASON, unknownEffectOptions } from '@momonga/protocol';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import type { Approval, Claim, RuntimeStore } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';
import { SNAPSHOT_STATE_VERSION } from '../src/codec.ts';
import { MIGRATIONS } from '../src/schema.ts';
import { DEADLINE_MS, START_MS, callEvent, cancel, enqueue, harness, makeStoreDir, mustClaim, mustRun, newSession, openStoreAt, payloadOf, rawDb } from './helpers.ts';
import { OPTIONS } from './approval-fixture.ts';

const FOUND = 'An earlier attempt of Write was interrupted before it reported a result. Its effect is unknown; inspect the current state before retrying.';

const unknownCall = (callId: string): RunEventPayload[] => [
  callEvent(callId),
  { type: 'tool.started', callId, idemKey: `idem-${callId}` },
  { type: 'tool.reconciled', callId, outcome: 'unknown', output: FOUND },
];

const stateOf = (store: RuntimeStore, runId: string): RunState => {
  const run = mustRun(store, runId);
  const events: RunEvent[] = store.readRunEvents(runId, 0, 1000);
  return events.reduce(foldRunState, initialRunState({ runId, sessionId: run.sessionId }));
};

const typesOf = (store: RuntimeStore, runId: string): string[] => store.readRunEvents(runId, 0, 1000).map((event) => event.type);

const asked = async (callIds: readonly string[], end: 'running' | 'waiting' = 'waiting'): Promise<{ store: RuntimeStore; dbPath: string; runId: string; claim: Claim; approval: Approval }> => {
  const { store, dbPath } = harness();
  const run = enqueue(store, newSession(store).id);
  const claim = mustClaim(store, 'worker-1');
  expect(store.append(claim, callIds.flatMap(unknownCall)).kind).toBe('ok');
  const result = await store.requestUnknownAck(claim, { callIds: [...callIds] });
  if (result.kind !== 'ok') throw new Error(`expected an approval, got ${result.kind}`);
  if (end === 'waiting') expect((await store.release(claim, 'WAITING_HUMAN')).kind).toBe('ok');
  return { store, dbPath, runId: run.id, claim, approval: result.approval };
};

describe('the fold of an unknown effect', () => {
  it('records a call reconciled as unknown as unacknowledged, and nothing for a known outcome or an interrupted call', async () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'worker-1');
    store.append(claim, [
      ...unknownCall('call_1'),
      callEvent('call_2'),
      { type: 'tool.started', callId: 'call_2', idemKey: 'idem-2' },
      { type: 'tool.reconciled', callId: 'call_2', outcome: 'already_applied', output: 'applied' },
      callEvent('call_3'),
      { type: 'tool.started', callId: 'call_3', idemKey: 'idem-3' },
      { type: 'tool.reconciled', callId: 'call_3', outcome: 'unknown', output: 'timed out', interrupted: 'timeout' },
    ]);
    expect(stateOf(store, run.id).unknownEffects).toEqual({ call_1: { acknowledged: false } });
  });

  it('starts empty', () => {
    expect(initialRunState({ runId: 'r', sessionId: 's' }).unknownEffects).toEqual({});
  });

  it('follows the ask, the answer, and leaves the output of the call in the history', async () => {
    const { store, runId, approval } = await asked(['call_1', 'call_2']);
    const pending = stateOf(store, runId);
    expect(pending.unknownEffects).toEqual({ call_1: { approvalId: approval.id, acknowledged: false }, call_2: { approvalId: approval.id, acknowledged: false } });
    expect(pending.pendingCalls['call_1']?.status).toBe('reconciled');
    expect((await store.resolveApproval(approval.id, 'allow_once')).kind).toBe('ok');
    const answered = stateOf(store, runId);
    expect(answered.unknownEffects).toEqual({ call_1: { approvalId: approval.id, acknowledged: true }, call_2: { approvalId: approval.id, acknowledged: true } });
    expect(answered.pendingCalls['call_1']?.status).toBe('reconciled');
  });
});

describe('store.requestUnknownAck', () => {
  it('writes one approval row of kind unknown_effect keyed by the first call, without an expiry, and one tool.unknown.requested naming every call', async () => {
    const { store, dbPath, runId, approval } = await asked(['call_1', 'call_2']);
    expect(approval).toMatchObject({ kind: 'unknown_effect', callId: 'call_1', status: 'pending', options: unknownEffectOptions() });
    expect(approval).not.toHaveProperty('expiresAt');
    expect(rawDb(dbPath).prepare('SELECT kind, call_id, expires_at FROM approvals WHERE run_id = ?').all(runId)).toEqual([{ kind: 'unknown_effect', call_id: 'call_1', expires_at: null }]);
    const requested = store.readRunEvents(runId, 0, 1000).filter((event) => event.type === 'tool.unknown.requested').map(payloadOf);
    expect(requested).toEqual([{ type: 'tool.unknown.requested', approvalId: approval.id, callIds: ['call_1', 'call_2'], options: unknownEffectOptions(), subjectDigest: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(mustRun(store, runId).status).toBe('WAITING_HUMAN');
  });

  it('asks once: a second request for the same calls returns the same approval and writes nothing', async () => {
    const { store, runId, claim, approval } = await asked(['call_1'], 'running');
    const before = mustRun(store, runId).lastSeq;
    const again = await store.requestUnknownAck(claim, { callIds: ['call_1'] });
    expect(again).toMatchObject({ kind: 'ok', approval: { id: approval.id } });
    expect(mustRun(store, runId).lastSeq).toBe(before);
  });

  it('refuses a stale claim', async () => {
    const { store, claim } = await asked(['call_1']);
    expect(await store.requestUnknownAck({ ...claim, leaseToken: claim.leaseToken + 1 }, { callIds: ['call_1'] })).toEqual({ kind: 'lease_lost' });
  });

  it('refuses an empty set of calls', async () => {
    const { store, claim } = await asked(['call_1'], 'running');
    await expect(store.requestUnknownAck(claim, { callIds: [] })).rejects.toThrow(/at least one call/);
  });
});

describe('the answer to an unknown effect', () => {
  it('writes tool.unknown.resolved and queues the run', async () => {
    const { store, runId, approval } = await asked(['call_1']);
    expect(await store.resolveApproval(approval.id, 'allow_once')).toMatchObject({ kind: 'ok', approval: { status: 'resolved', optionId: 'allow_once' }, run: { id: runId, status: 'QUEUED' } });
    expect(typesOf(store, runId).filter((type) => type.startsWith('tool.unknown.') || type.startsWith('tool.permission.'))).toEqual(['tool.unknown.requested', 'tool.unknown.resolved']);
  });

  it('offers only Continue', async () => {
    const { store, approval } = await asked(['call_1']);
    expect(await store.resolveApproval(approval.id, 'reject_once')).toEqual({ kind: 'option_not_offered' });
  });

  it('shows the call, why its effect is unknown and what the recovery found', async () => {
    const { store, runId, approval } = await asked(['call_1', 'call_2']);
    const view = await store.approvalView(approval.id);
    expect(view).toMatchObject({
      id: approval.id,
      kind: 'unknown_effect',
      callId: 'call_1',
      options: unknownEffectOptions(),
      toolCall: { callId: 'call_1', title: 'Write call_1' },
      reason: [`Write call_1: ${UNKNOWN_EFFECT_REASON}`, `What the recovery found: ${FOUND}`, `Write call_2: ${UNKNOWN_EFFECT_REASON}`, `What the recovery found: ${FOUND}`, UNKNOWN_EFFECT_ADVICE].join('\n'),
    });
    expect((await store.pendingApprovalViews(runId)).map((pending) => pending.id)).toEqual([approval.id]);
  });

  it('a permission approval view names its kind', async () => {
    const { store } = harness();
    enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'worker-1');
    store.append(claim, [callEvent('call_1')]);
    const result = await store.requestApproval(claim, { callId: 'call_1', options: OPTIONS, event: { subjectDigest: 'a'.repeat(64), reason: 'edits require approval' } });
    if (result.kind !== 'ok') throw new Error('expected an approval');
    expect(await store.approvalView(result.approval.id)).toMatchObject({ kind: 'permission' });
  });
});

describe('an unknown ask that is not answered', () => {
  it('is withdrawn by a cancel with tool.unknown.cancelled, folds without throwing and leaves the call unacknowledged', async () => {
    const { store, runId, approval } = await asked(['call_1']);
    await cancel(store, runId);
    expect(store.approvals.get(approval.id)?.status).toBe('withdrawn');
    expect(store.readRunEvents(runId, 0, 1000).filter((event) => event.type === 'tool.unknown.cancelled').map(payloadOf)).toEqual([{ type: 'tool.unknown.cancelled', approvalId: approval.id, reason: 'withdrawn' }]);
    expect(typesOf(store, runId)).not.toContain('tool.permission.cancelled');
    expect(stateOf(store, runId).unknownEffects).toEqual({ call_1: { acknowledged: false } });
  });

  it('has no expiry: every sweep before the deadline leaves it pending, and the deadline stops the run with timeout and withdraws it', async () => {
    const { store, runId, approval } = await asked(['call_1']);
    const rethrow = (error: unknown): never => {
      throw error;
    };
    expect(await store.expireApprovals(DEADLINE_MS - 1, rethrow)).toEqual([]);
    expect(store.approvals.get(approval.id)?.status).toBe('pending');
    expect(await store.expireApprovals(DEADLINE_MS, rethrow)).toEqual([runId]);
    expect(mustRun(store, runId)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
    expect(store.approvals.get(approval.id)?.status).toBe('withdrawn');
    expect(stateOf(store, runId).unknownEffects).toEqual({ call_1: { acknowledged: false } });
  });

  it('a new ask after a cancelled one is a new row and a new event', async () => {
    const { store, dbPath, runId, claim, approval } = await asked(['call_1'], 'running');
    rawDb(dbPath).prepare("UPDATE approvals SET status = 'withdrawn' WHERE id = ?").run(approval.id);
    expect(store.append(claim, [{ type: 'tool.unknown.cancelled', approvalId: approval.id, reason: 'withdrawn' }]).kind).toBe('ok');
    const again = await store.requestUnknownAck(claim, { callIds: ['call_1'] });
    if (again.kind !== 'ok') throw new Error('expected an approval');
    expect(again.approval.id).not.toBe(approval.id);
    expect(stateOf(store, runId).unknownEffects).toEqual({ call_1: { approvalId: again.approval.id, acknowledged: false } });
  });
});

describe('the snapshot of a run with an unknown effect', () => {
  it('round-trips unknownEffects, and a snapshot of the version before is refolded from the journal', async () => {
    const { store, dbPath, runId, claim } = await asked(['call_1'], 'running');
    const state = stateOf(store, runId);
    expect(store.writeSnapshot(claim, state.lastSeq, state)).toEqual({ kind: 'ok' });
    expect(store.load(runId).snapshot?.state).toEqual(state);
    expect(SNAPSHOT_STATE_VERSION).toBe(19);
    rawDb(dbPath).prepare("UPDATE snapshots SET state_json = json_remove(json_set(state_json, '$.stateVersion', 17), '$.unknownEffects') WHERE run_id = ?").run(runId);
    const loaded = store.load(runId);
    expect(loaded.snapshot).toBeUndefined();
    expect(loaded.tail.reduce(foldRunState, initialRunState({ runId, sessionId: state.sessionId }))).toEqual(state);
  });

  it('reports a snapshot whose unknownEffects is malformed as corrupt', async () => {
    const { store, dbPath, runId, claim } = await asked(['call_1'], 'running');
    const state = stateOf(store, runId);
    store.writeSnapshot(claim, state.lastSeq, state);
    rawDb(dbPath).prepare("UPDATE snapshots SET state_json = json_set(state_json, '$.unknownEffects.call_1.acknowledged', 'yes') WHERE run_id = ?").run(runId);
    expect(() => store.load(runId)).toThrow(/RunState/);
  });
});

const versionThirtyThree = (): string => {
  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  const db = new DatabaseSync(dbPath);
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 33));
    db.prepare('INSERT INTO sessions (id, cwd, env_json, permission_mode, model, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s1', '/work/a', '{}', 'manual', 'fm', START_MS);
    db.prepare(
      `INSERT INTO runs (id, session_id, ordinal, status, version, lease_owner, lease_token, lease_expires_at, available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at)
       VALUES ('r1', 's1', 1, 'WAITING_HUMAN', 1, NULL, 1, NULL, ?, 1, 0, 0, ?, '{}', ?, 1, 0, '{}', 0, ?)`,
    ).run(START_MS, DEADLINE_MS, canonicalJson({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), START_MS);
    const insert = db.prepare(
      `INSERT INTO approvals (id, run_id, call_id, status, options_json, option_id, expires_at, created_at, resolved_at, subject_digest, kind, server, requests_json, responses_json)
       VALUES (?, 'r1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('appr-pending', 'call_1', 'pending', JSON.stringify(OPTIONS), null, null, START_MS, null, 'a'.repeat(64), 'permission', null, null, null);
    insert.run('appr-resolved', 'call_2', 'resolved', JSON.stringify(OPTIONS), 'allow_once', null, START_MS + 1, START_MS + 2, 'b'.repeat(64), 'permission', null, null, null);
    insert.run('input-1', 'call_3', 'resolved', '[]', null, START_MS + 500, START_MS + 3, START_MS + 4, null, 'elicitation', 'remote', '[]', '{}');
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
  return dbPath;
};

const APPROVAL_ROWS = 'SELECT id, run_id, call_id, status, options_json, option_id, expires_at, created_at, resolved_at, subject_digest, kind, server, requests_json, responses_json FROM approvals ORDER BY rowid';

describe('migration 34: an approval may ask about an unknown effect, and a rule set has a stored verdict', () => {
  it('is version 34, the first after 33', () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions.indexOf(34)).toBe(versions.indexOf(33) + 1);
  });

  it('rebuilds approvals keeping every row and its order, its indexes, and accepts the kind unknown_effect and no other new kind', () => {
    const dbPath = versionThirtyThree();
    const before = new DatabaseSync(dbPath);
    const rows = before.prepare(APPROVAL_ROWS).all();
    before.close();
    openStoreAt(dbPath, createFakeClock(START_MS + 10)).close();
    const db = rawDb(dbPath);
    expect(db.prepare(APPROVAL_ROWS).all()).toEqual(rows);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'approvals' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row['name'])).toEqual(['approvals_by_call', 'approvals_by_expiry', 'approvals_one_pending_per_call']);
    const insert = db.prepare("INSERT INTO approvals (id, run_id, call_id, status, options_json, expires_at, created_at, kind) VALUES (?, 'r1', ?, 'pending', '[]', ?, ?, ?)");
    insert.run('unknown-1', 'call_9', null, START_MS, 'unknown_effect');
    expect(() => insert.run('unknown-2', 'call_10', START_MS + 1, START_MS, 'unknown_effect')).toThrow(/CHECK/);
    expect(() => insert.run('other-1', 'call_11', null, START_MS, 'something_else')).toThrow(/CHECK/);
    expect(() => insert.run('second-pending', 'call_9', null, START_MS, 'unknown_effect')).toThrow(/UNIQUE/);
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 39 });
  });

  it('creates rule_verdicts keyed by the fingerprint', () => {
    const dbPath = versionThirtyThree();
    openStoreAt(dbPath, createFakeClock(START_MS + 10)).close();
    expect(rawDb(dbPath).prepare('PRAGMA table_info(rule_verdicts)').all().map((column) => [column['name'], column['pk']])).toEqual([
      ['fingerprint', 1],
      ['verdict_json', 0],
      ['solver_version', 0],
      ['created_at', 0],
    ]);
  });
});
