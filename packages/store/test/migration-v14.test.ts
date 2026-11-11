import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { canonicalJson, migrate, openDatabase, BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import { createJournalReader } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, enqueue, harness, makeStoreDir, mustClaim, newSession, openStoreAt, rawDb, registerCleanup } from './helpers.ts';

const requested = (step: number, pinnedDigest?: string): RunEventPayload =>
  ({ type: 'model.requested', step, attempt: 1, digest: `d${step}`, ...(pinnedDigest === undefined ? {} : { pinnedDigest }), body: { model: 'fm', input: [] } }) as RunEventPayload;

const SYSTEM = { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'You are the agent.' }] };

const TOOL = { type: 'function', name: 'Echo', description: 'echo', parameters: { type: 'object' } };

const oldRequest = (step: number): RunEventPayload =>
  ({
    type: 'model.requested',
    step,
    attempt: 1,
    digest: `d${step}`,
    body: { model: 'fm', input: [SYSTEM, { type: 'message', role: 'user', content: [{ type: 'input_text', text: `turn ${step}` }] }], tools: [TOOL], tool_choice: 'auto' },
  }) as RunEventPayload;

const OLD_PAYLOADS: RunEventPayload[] = [{ type: 'user.message', text: 'hi' }, oldRequest(1), oldRequest(2)];

const versionThirteen = (): string => {
  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  const db = new DatabaseSync(dbPath);
  try {
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 13));
    db.prepare('INSERT INTO sessions (id, cwd, env_json, permission_mode, model_alias, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s1', '/work/a', '{}', 'default', 'fm', START_MS);
    db.prepare(
      `INSERT INTO runs (id, session_id, ordinal, status, version, lease_owner, lease_token, lease_expires_at, available_at, attempts, failed_attempts, cancel_requested, deadline_at, limits_json, usage_json, step, last_seq, pins, dead_letter, created_at)
       VALUES (?, ?, 1, 'RUNNING', 1, 'w1', 1, ?, ?, 1, 0, 0, ?, '{}', ?, 2, 3, '{}', 0, ?)`,
    ).run('r1', 's1', START_MS + 1_000_000, START_MS, START_MS + 3_600_000, canonicalJson({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), START_MS);
    const insertEvent = db.prepare('INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json) VALUES (?, ?, ?, ?, 1, ?, ?, ?)');
    OLD_PAYLOADS.forEach((payload, index) => insertEvent.run('r1', 's1', index + 1, 'step' in payload ? payload.step : 0, START_MS, payload.type, canonicalJson(payload)));
    db.prepare('INSERT INTO reflection_jobs (run_id, state, attempts, last_error, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)').run('r1', 'done', 'the model proposed no candidates', START_MS, START_MS);
  } finally {
    db.close();
  }
  fs.chmodSync(dbPath, 0o600);
  return dbPath;
};

describe('an upgrade from version 13 over rows that already exist', () => {
  it('leaves the pinned digest of every old model request empty and the dropped candidates of every old reflection job empty', () => {
    const dbPath = versionThirteen();
    openStoreAt(dbPath, createFakeClock(START_MS + 10)).close();

    const db = rawDb(dbPath);
    expect(db.prepare("SELECT pinned_digest FROM events WHERE type = 'model.requested' ORDER BY seq").all().map((row) => row['pinned_digest'])).toEqual([null, null]);
    expect(db.prepare('SELECT dropped_json FROM reflection_jobs').all().map((row) => row['dropped_json'])).toEqual([null]);
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toMatchObject({ version: 39 });
  });

  it('still decodes an old reflection job, with no dropped candidates and the reason it had', () => {
    const store = openStoreAt(versionThirteen(), createFakeClock(START_MS + 10));

    expect(store.reflection.get('r1')).toEqual({
      runId: 'r1',
      state: 'done',
      attempts: 1,
      lastError: 'the model proposed no candidates',
      dropped: [],
      createdAt: START_MS,
      updatedAt: START_MS,
    });
  });

  it('the journal reader measures an old run, and the hook reads every old model request, because none of them has a digest to de-duplicate by', () => {
    const seen: RunEvent[][] = [];
    const dbPath = versionThirteen();
    openStoreAt(dbPath, createFakeClock(START_MS + 10));
    const reader = openDatabase(dbPath, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
    registerCleanup(() => reader.close());

    createJournalReader(reader).measure(
      {
        eventTypes: ['model.requested'],
        measure: ({ events }) => {
          seen.push([...events]);
          return undefined;
        },
      },
      { runId: 'r1', leading: [] },
    );

    expect(seen).toHaveLength(1);
    const requests = (seen[0] ?? []).filter((event) => event.type === 'model.requested');
    expect(requests.map((event) => event.type === 'model.requested' && event.digest)).toEqual(['d1', 'd2']);
    for (const request of requests) {
      expect(request.type === 'model.requested' && request.body).toMatchObject({ input: [SYSTEM], tools: [TOOL], tool_choice: 'auto' });
    }
  });

  it('reads the events of an old run as they were written', () => {
    const store = openStoreAt(versionThirteen(), createFakeClock(START_MS + 10));

    const events = store.readRunEvents('r1', 0, 100);

    expect(events.map((event) => event.type)).toEqual(['user.message', 'model.requested', 'model.requested']);
    expect(events[1]).toMatchObject({ type: 'model.requested', digest: 'd1', body: (oldRequest(1) as Extract<RunEventPayload, { type: 'model.requested' }>).body });
  });
});

describe('migration v14', () => {
  it('records the pinned-layer digest of a request appended after the migration in the events column and leaves other events without one', () => {
    const h = harness();
    enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    const digest = 'c'.repeat(64);

    expect(h.store.append(claim, [requested(1, digest), requested(2), { type: 'user.message', text: 'hi' }]).kind).toBe('ok');

    const rows = rawDb(h.dbPath).prepare('SELECT type, pinned_digest FROM events WHERE type IN (\'model.requested\', \'user.message\') ORDER BY seq').all();
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { type: 'user.message', pinned_digest: null },
      { type: 'model.requested', pinned_digest: digest },
      { type: 'model.requested', pinned_digest: null },
      { type: 'user.message', pinned_digest: null },
    ]);
  });
});
