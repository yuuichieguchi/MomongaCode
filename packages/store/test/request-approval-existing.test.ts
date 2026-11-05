import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import type { PermissionOption } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, makeStoreDir, mustClaim, mustRun, openStoreAt } from './helpers.ts';

const OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];
const DIGEST = 'a'.repeat(64);

const populateV1WithLegacyApproval = (dbPath: string): void => {
  const db = new DatabaseSync(dbPath);
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version === 1));
    db.prepare(
      `INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at)
       VALUES ('sess-1', '/work/a', '{}', 'default', 'fm', ?)`,
    ).run(START_MS);
    db.prepare(
      `INSERT INTO runs (id, session_id, ordinal, idempotency_key, status, stop_reason, version, lease_owner, lease_token, lease_expires_at,
         available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, error_json,
         dead_letter, created_at)
       VALUES ('run-1', 'sess-1', 1, NULL, 'QUEUED', NULL, 1, NULL, 0, NULL, ?, 0, 0, 0, ?, '{}',
         '{"inputTokens":0,"outputTokens":0,"totalTokens":0}', 0, 1, '{}', NULL, 0, ?)`,
    ).run(START_MS, START_MS + 3_600_000, START_MS);
    db.prepare(
      `INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json)
       VALUES ('run-1', 'sess-1', 1, 0, 0, ?, 'user.message', '{"text":"write","type":"user.message"}')`,
    ).run(START_MS);
    db.prepare(
      `INSERT INTO approvals (id, run_id, call_id, status, options_json, option_id, expires_at, created_at, resolved_at)
       VALUES ('appr-legacy', 'run-1', 'call_1', 'pending', ?, NULL, ?, ?, NULL)`,
    ).run(JSON.stringify(OPTIONS), START_MS + 60_000, START_MS);
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
};

describe('store.requestApproval with a pending approval migrated from v1 without a digest', () => {
  it('supersedes the legacy approval, and the fold follows the new approval', async () => {
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    populateV1WithLegacyApproval(dbPath);
    const store = openStoreAt(dbPath, createFakeClock(START_MS + 100));
    expect(store.approvals.get('appr-legacy')).toMatchObject({ status: 'pending', callId: 'call_1' });
    expect(store.approvals.get('appr-legacy')).not.toHaveProperty('subjectDigest');
    const claim = mustClaim(store, 'worker-1');
    const appended = store.append(claim, [
      { type: 'tool.call', callId: 'call_1', providerCallId: 'call_1', name: 'Write', kind: 'edit', title: 'Write', rawInput: {} },
    ]);
    if (appended.kind !== 'ok') throw new Error('expected the append to succeed');

    const result = store.requestApproval(claim, { callId: 'call_1', options: OPTIONS, expiresAt: START_MS + 60_000, event: { subjectDigest: DIGEST, reason: 'edits require approval' } });

    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
    expect(result.approval.id).not.toBe('appr-legacy');
    expect(store.approvals.get('appr-legacy')?.status).toBe('superseded');
    expect(await store.resolveApproval('appr-legacy', 'allow_once')).toEqual({ kind: 'approval_not_pending', status: 'superseded' });
    const fresh = () => initialRunState({ runId: 'run-1', sessionId: 'sess-1' });
    const requests = store.readRunEvents('run-1', 0, 100).filter((event) => event.type === 'tool.permission.requested');
    expect(requests).toEqual([expect.objectContaining({ approvalId: result.approval.id, callId: 'call_1', subjectDigest: DIGEST })]);
    expect(store.readRunEvents('run-1', 0, 100).reduce(foldRunState, fresh()).pendingCalls['call_1']).toMatchObject({
      status: 'awaiting_approval',
      approvalId: result.approval.id,
    });

    expect((await store.resolveApproval(result.approval.id, 'allow_once')).kind).toBe('ok');
    expect(store.release(claim, 'WAITING_HUMAN').kind).toBe('ok');
    expect(mustRun(store, 'run-1').status).toBe('QUEUED');
    expect(store.readRunEvents('run-1', 0, 100).reduce(foldRunState, fresh()).pendingCalls['call_1']).toMatchObject({
      status: 'requested',
      resolution: { optionId: 'allow_once', kind: 'allow_once', subjectDigest: DIGEST },
    });
  });
});
