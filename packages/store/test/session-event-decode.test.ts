import { describe, expect, it } from 'vitest';
import { START_MS, enqueue, harness, newSession, rawDb } from './helpers.ts';

const insertRow = (dbPath: string, row: { runId: string | null; sessionId: string; seq: number | null; type: string; payload: unknown }) =>
  rawDb(dbPath)
    .prepare(
      `INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.runId, row.sessionId, row.seq, row.seq === null ? null : 0, row.seq === null ? null : 0, START_MS, row.type, JSON.stringify(row.payload));

describe('event decoding after mode.changed became session-scoped', () => {
  it('treats a run-scoped mode.changed row as corrupt', () => {
    const { dbPath, store } = harness();
    const run = enqueue(store, newSession(store).id);
    insertRow(dbPath, { runId: run.id, sessionId: run.sessionId, seq: 2, type: 'mode.changed', payload: { type: 'mode.changed', mode: 'plan' } });

    expect(() => store.readRunEvents(run.id, 0, 100)).toThrow(/mode\.changed/);
  });

  it('treats a session-scoped row with a run event type as corrupt', () => {
    const { dbPath, store } = harness();
    const session = newSession(store);
    insertRow(dbPath, { runId: null, sessionId: session.id, seq: null, type: 'notice', payload: { type: 'notice', level: 'info', message: 'x' } });

    expect(() => store.readSessionEvents(session.id, 0, 100)).toThrow(/notice/);
  });

  it('decodes a session-scoped mode.changed row as a SessionEvent', () => {
    const { dbPath, store } = harness();
    const session = newSession(store);
    insertRow(dbPath, { runId: null, sessionId: session.id, seq: null, type: 'mode.changed', payload: { type: 'mode.changed', mode: 'plan' } });

    expect(store.readSessionEvents(session.id, 0, 100)).toEqual([
      { id: expect.any(Number), sessionId: session.id, createdAt: START_MS, type: 'mode.changed', mode: 'plan' },
    ]);
  });
});
