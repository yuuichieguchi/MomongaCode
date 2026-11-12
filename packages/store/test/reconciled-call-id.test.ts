import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { canonicalJson, migrate } from '@momonga/foundation';
import type { RunEventPayload } from '@momonga/protocol';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';

const RECONCILED_CALL_ID_MIGRATION = 44;
import { START_MS, enqueue, harness, makeStoreDir, mustClaim, newSession, openStoreAt, rawDb } from './helpers.ts';

const call: RunEventPayload = { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Bash', kind: 'execute', title: 'Bash', rawInput: {} };
const reconciled: RunEventPayload = { type: 'tool.reconciled', callId: 'c1', outcome: 'not_applied', output: 'not run' };

const callIdOfReconciled = (dbPath: string, runId: string): unknown =>
  rawDb(dbPath).prepare("SELECT call_id FROM events WHERE run_id = ? AND type = 'tool.reconciled'").get(runId)?.['call_id'];

describe('the call id of a tool.reconciled event is a column of its row', () => {
  it('is written at append', async () => {
    const { store, dbPath } = harness();
    const session = newSession(store);
    const run = await enqueue(store, session.id);
    const claim = mustClaim(store, 'w1');
    expect(store.append(claim, [call, reconciled]).kind).toBe('ok');
    expect(callIdOfReconciled(dbPath, run.id)).toBe('c1');
  });

  it('is filled by a migration of its own for a row written before', () => {
    const before = MIGRATIONS.filter((migration) => migration.version < RECONCILED_CALL_ID_MIGRATION);
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    const db = new DatabaseSync(dbPath);
    try {
      migrate(db, before);
      db.prepare('INSERT INTO sessions (id, cwd, env_json, permission_mode, model, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s1', '/work/a', '{}', 'manual', 'fm', START_MS);
      db.prepare(
        `INSERT INTO runs (id, session_id, ordinal, status, version, lease_owner, lease_token, lease_expires_at, available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at)
         VALUES ('r1', 's1', 1, 'COMPLETED', 1, NULL, 1, NULL, ?, 1, 0, 0, ?, '{}', ?, 1, 2, '{}', 0, ?)`,
      ).run(START_MS, START_MS + 3_600_000, canonicalJson({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), START_MS);
      const insertEvent = db.prepare('INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json) VALUES (?, ?, ?, 1, 1, ?, ?, ?)');
      [call, reconciled].forEach((payload, index) => insertEvent.run('r1', 's1', index + 1, START_MS, payload.type, canonicalJson(payload)));
    } finally {
      db.close();
    }
    fs.chmodSync(dbPath, 0o600);
    expect(callIdOfReconciled(dbPath, 'r1')).toBeNull();
    openStoreAt(dbPath, createFakeClock(START_MS + 10));
    expect(callIdOfReconciled(dbPath, 'r1')).toBe('c1');
  });
});
