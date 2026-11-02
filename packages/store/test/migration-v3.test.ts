import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { migrate } from '@momonga/foundation';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, makeStoreDir, mustRun, openStoreAt, rawDb } from './helpers.ts';

const OPTIONS_JSON = '[{"kind":"allow_once","name":"Allow once","optionId":"allow_once"},{"kind":"reject_once","name":"Reject","optionId":"reject_once"}]';
const DIGEST = 'a'.repeat(64);

const populateV2 = (dbPath: string): void => {
  const db = new DatabaseSync(dbPath);
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 2));
    db.prepare(
      `INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at)
       VALUES ('sess-1', '/work/a', '{"PATH":"/usr/bin"}', 'acceptEdits', 'fm', ?)`,
    ).run(START_MS);
    db.prepare(
      `INSERT INTO runs (id, session_id, ordinal, idempotency_key, status, stop_reason, version, lease_owner, lease_token, lease_expires_at,
         available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, error_json,
         dead_letter, created_at)
       VALUES ('run-1', 'sess-1', 1, 'key-1', 'WAITING_HUMAN', NULL, 3, NULL, 1, NULL, ?, 1, 0, 0, ?, '{"maxSteps":10}',
         '{"inputTokens":5,"outputTokens":2,"totalTokens":7}', 1, 2, '{"model":"fm"}', NULL, 0, ?)`,
    ).run(START_MS, START_MS + 3_600_000, START_MS);
    const insertEvent = db.prepare(
      `INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json)
       VALUES ('run-1', 'sess-1', ?, ?, 1, ?, ?, ?)`,
    );
    insertEvent.run(1, 0, START_MS, 'user.message', '{"text":"hello","type":"user.message"}');
    insertEvent.run(
      2,
      1,
      START_MS + 1,
      'tool.call',
      '{"callId":"call_2","kind":"edit","name":"Write","providerCallId":"call_2","rawInput":{},"title":"Write","type":"tool.call"}',
    );
    db.prepare(
      `INSERT INTO approvals (id, run_id, call_id, status, options_json, option_id, expires_at, created_at, resolved_at, subject_digest)
       VALUES ('appr-resolved', 'run-1', 'call_1', 'resolved', ?, 'allow_once', ?, ?, ?, ?)`,
    ).run(OPTIONS_JSON, START_MS + 60_000, START_MS, START_MS + 10, DIGEST);
    db.prepare(
      `INSERT INTO approvals (id, run_id, call_id, status, options_json, option_id, expires_at, created_at, resolved_at, subject_digest)
       VALUES ('appr-pending', 'run-1', 'call_2', 'pending', ?, NULL, ?, ?, NULL, ?)`,
    ).run(OPTIONS_JSON, START_MS + 60_000, START_MS, DIGEST);
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
};

const migrated = () => {
  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  populateV2(dbPath);
  const store = openStoreAt(dbPath, createFakeClock(START_MS + 100));
  return { dbPath, store };
};

describe('migration v3 on a populated v2 database', () => {
  it('records the third migration', () => {
    const { dbPath } = migrated();
    expect(rawDb(dbPath).prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => Number(row['version']))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('keeps sessions, runs, events and approvals', () => {
    const { store } = migrated();

    expect(store.getSession('sess-1')).toMatchObject({ cwd: '/work/a', env: { PATH: '/usr/bin' }, permissionMode: 'acceptEdits', modelAlias: 'fm', bypassAllowed: false });
    expect(mustRun(store, 'run-1')).toMatchObject({
      status: 'WAITING_HUMAN',
      version: 3,
      lastSeq: 2,
      limits: { maxSteps: 10 },
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    });
    expect(store.readRunEvents('run-1', 0, 100).map((event) => [event.seq, event.type])).toEqual([
      [1, 'user.message'],
      [2, 'tool.call'],
    ]);
    expect(store.readSessionEvents('sess-1', 0, 100)).toHaveLength(2);
    expect(store.approvals.get('appr-resolved')).toMatchObject({ status: 'resolved', optionId: 'allow_once', subjectDigest: DIGEST });
    expect(store.approvals.listPending('run-1').map((approval) => approval.id)).toEqual(['appr-pending']);
  });

  it('adds the new columns with NULL and default values', () => {
    const { dbPath } = migrated();
    const db = rawDb(dbPath);
    expect(db.prepare('SELECT request_digest, previous_run_id FROM runs').all()).toEqual([{ request_digest: null, previous_run_id: null }]);
    expect(db.prepare('SELECT bypass_allowed FROM sessions').all()).toEqual([{ bypass_allowed: 0 }]);
  });

  it('keeps every index and trigger', () => {
    const { dbPath } = migrated();
    const names = rawDb(dbPath)
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name")
      .all()
      .map((row) => row['name']);
    expect(names).toEqual(
      expect.arrayContaining([
        'approvals_by_call',
        'approvals_by_expiry',
        'approvals_one_pending_per_call',
        'events_by_session',
        'events_reject_delete',
        'events_reject_update',
        'idempotency_by_expiry',
        'runs_by_session_idempotency_key',
        'runs_by_status_availability',
        'sessions_by_cwd',
      ]),
    );
  });

  it('still refuses a second pending approval for one call', () => {
    const { dbPath } = migrated();
    expect(() =>
      rawDb(dbPath)
        .prepare(
          `INSERT INTO approvals (id, run_id, call_id, status, options_json, option_id, expires_at, created_at, resolved_at)
           VALUES ('appr-dup', 'run-1', 'call_2', 'pending', ?, NULL, ?, ?, NULL)`,
        )
        .run(OPTIONS_JSON, START_MS + 60_000, START_MS),
    ).toThrow(/UNIQUE/);
  });

  it('accepts the new approval statuses and nothing else', () => {
    const { dbPath } = migrated();
    const db = rawDb(dbPath);
    for (const status of ['expired', 'withdrawn', 'superseded', 'resolved']) {
      db.prepare("UPDATE approvals SET status = ? WHERE id = 'appr-resolved'").run(status);
    }
    expect(() => db.prepare("UPDATE approvals SET status = 'bogus' WHERE id = 'appr-resolved'").run()).toThrow(/CHECK/);
  });

  it('keeps events append-only', () => {
    const { dbPath } = migrated();
    const db = rawDb(dbPath);
    expect(() => db.prepare("UPDATE events SET type = 'notice'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM events').run()).toThrow(/append-only/);
  });

  it('accepts a session-scoped event with run_id, seq, step and lease_token all NULL', () => {
    const { dbPath } = migrated();
    rawDb(dbPath)
      .prepare(
        `INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json)
         VALUES (NULL, 'sess-1', NULL, NULL, NULL, ?, 'mode.changed', '{"mode":"plan","type":"mode.changed"}')`,
      )
      .run(START_MS);
  });

  it.each([
    ['a run_id without a seq', "'run-1'", 'NULL', '0', '1'],
    ['a seq without a run_id', 'NULL', '9', '0', '1'],
    ['a NULL step only', "'run-1'", '9', 'NULL', '1'],
    ['a NULL lease_token only', "'run-1'", '9', '0', 'NULL'],
  ])('rejects an event row with %s through the CHECK', (_label, runId, seq, step, leaseToken) => {
    const { dbPath } = migrated();
    expect(() =>
      rawDb(dbPath)
        .prepare(
          `INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json)
           VALUES (${runId}, 'sess-1', ${seq}, ${step}, ${leaseToken}, ?, 'mode.changed', '{"mode":"plan","type":"mode.changed"}')`,
        )
        .run(START_MS),
    ).toThrow(/CHECK/);
  });
});
