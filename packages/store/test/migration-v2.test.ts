import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, makeStoreDir, openStoreAt } from './helpers.ts';

const OPTIONS_JSON = '[{"kind":"allow_once","name":"Allow once","optionId":"allow_once"},{"kind":"reject_once","name":"Reject","optionId":"reject_once"}]';

const populateV1 = (dbPath: string): void => {
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
       VALUES ('run-1', 'sess-1', 1, NULL, 'WAITING_HUMAN', NULL, 3, NULL, 1, NULL, ?, 1, 0, 0, ?, '{}',
         '{"inputTokens":0,"outputTokens":0,"totalTokens":0}', 1, 0, '{}', NULL, 0, ?)`,
    ).run(START_MS, START_MS + 3_600_000, START_MS);
    db.prepare(
      `INSERT INTO approvals (id, run_id, call_id, status, options_json, option_id, expires_at, created_at, resolved_at)
       VALUES ('appr-resolved', 'run-1', 'call_1', 'resolved', ?, 'allow_once', ?, ?, ?)`,
    ).run(OPTIONS_JSON, START_MS + 60_000, START_MS, START_MS + 10);
    db.prepare(
      `INSERT INTO approvals (id, run_id, call_id, status, options_json, option_id, expires_at, created_at, resolved_at)
       VALUES ('appr-pending', 'run-1', 'call_2', 'pending', ?, NULL, ?, ?, NULL)`,
    ).run(OPTIONS_JSON, START_MS + 60_000, START_MS);
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
};

describe('migration v2 on a populated v1 database', () => {
  it('keeps every approval and allows a renewal for a resolved call', () => {
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    populateV1(dbPath);
    const clock = createFakeClock(START_MS + 100);

    const store = openStoreAt(dbPath, clock);

    expect(store.approvals.get('appr-resolved')).toMatchObject({ runId: 'run-1', callId: 'call_1', status: 'resolved', optionId: 'allow_once' });
    expect(store.approvals.listPending('run-1').map((approval) => approval.id)).toEqual(['appr-pending']);
    expect(store.approvals.get('appr-pending')?.subjectDigest ?? null).toBeNull();
    expect(store.approvals.get('appr-resolved')?.subjectDigest ?? null).toBeNull();
    const options = store.approvals.get('appr-resolved')?.options ?? [];
    const renewed = store.approvals.create({ runId: 'run-1', callId: 'call_1', options, expiresAt: START_MS + 120_000, renewal: true });
    if (renewed.kind !== 'ok') throw new Error('expected the renewal to succeed after migration');
    expect(store.approvals.listPending('run-1').map((approval) => approval.callId).sort()).toEqual(['call_1', 'call_2']);
  });

  it('records both migrations and still refuses a second pending approval for one call', () => {
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    populateV1(dbPath);
    openStoreAt(dbPath, createFakeClock(START_MS + 100)).close();

    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => Number(row['version']))).toEqual([1, 2]);
      expect(db.prepare('SELECT id, subject_digest FROM approvals ORDER BY id').all().map((row) => [row['id'], row['subject_digest']])).toEqual([
        ['appr-pending', null],
        ['appr-resolved', null],
      ]);
      expect(() =>
        db
          .prepare(
            `INSERT INTO approvals (id, run_id, call_id, status, options_json, option_id, expires_at, created_at, resolved_at)
             VALUES ('appr-dup', 'run-1', 'call_2', 'pending', ?, NULL, ?, ?, NULL)`,
          )
          .run(OPTIONS_JSON, START_MS + 60_000, START_MS),
      ).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });
});
