import { describe, expect, it } from 'vitest';
import { ERROR_WINDOW } from '@momonga/protocol';
import type { RunEventPayload } from '@momonga/protocol';
import { SESSION_TOUCHED_DERIVATION, APPEND_TIME_RECORDS_DERIVATION, createAppendRecords } from '../../src/append-records.ts';
import type { RecordedEvent } from '../../src/append-records.ts';
import { enqueue, harness, newSession, rawDb } from '../helpers.ts';

const COUNTER = 'c'.repeat(64);

const touch = (eventId: number, runId: string, sessionId: string): RecordedEvent => ({
  eventId,
  runId,
  sessionId,
  seq: eventId,
  step: 1,
  payload: { type: 'tool.call', callId: `c${eventId}`, providerCallId: `c${eventId}`, name: 'Write', kind: 'edit', title: 'w', rawInput: { file_path: '/work/a/x.txt' }, locations: [{ path: '/work/a/x.txt' }] },
});

const meter = (eventId: number, runId: string, sessionId: string): RecordedEvent => ({
  eventId,
  runId,
  sessionId,
  seq: eventId,
  step: 1,
  payload: {
    type: 'meter.observed',
    target: 'primary',
    counter: COUNTER,
    fallback: false,
    inputDigest: 'd'.repeat(64),
    itemCount: 1,
    counted: 100 + eventId,
    reported: 100,
    kept: 100,
    known: 100,
    uncounted: eventId,
    miss: eventId,
    contextWindow: 8192,
    tokenCounting: 'estimated',
  } as RunEventPayload,
});

const recordsAfter = async (order: readonly ((runs: readonly string[], sessionId: string) => RecordedEvent)[]): Promise<unknown> => {
  const { store, dbPath } = harness();
  const session = newSession(store);
  const runs = [(await enqueue(store, session.id, 'a')).id, (await enqueue(store, session.id, 'b')).id];
  const db = rawDb(dbPath);
  const records = createAppendRecords(db);
  for (const event of order) {
    const recorded = event(runs, session.id);
    records.recordFor(recorded.payload.type === 'tool.call' ? SESSION_TOUCHED_DERIVATION : APPEND_TIME_RECORDS_DERIVATION, recorded);
  }
  const touched = db.prepare('SELECT path, first_event_id FROM session_touched WHERE session_id = ?').all(session.id);
  const meters = db.prepare('SELECT seq, event_json, misses_json, run_id = ? AS first_run FROM meter_records WHERE session_id = ?').all(runs[0] ?? '', session.id);
  return { touched, meters };
};

const touchedA = (runs: readonly string[], sessionId: string) => touch(10, runs[0] ?? '', sessionId);
const touchedB = (runs: readonly string[], sessionId: string) => touch(20, runs[1] ?? '', sessionId);
const meteredA = (runs: readonly string[], sessionId: string) => meter(11, runs[0] ?? '', sessionId);
const meteredB = (runs: readonly string[], sessionId: string) => meter(21, runs[1] ?? '', sessionId);

describe('a session-scoped derivation is a function of the set of events it covers (H7, 11.5 correction rule 3)', () => {
  it('session_touched keeps the least first_event_id whatever order the runs are repaired in', async () => {
    const forward = await recordsAfter([touchedA, touchedB]);
    const backward = await recordsAfter([touchedB, touchedA]);
    expect(backward).toEqual(forward);
    expect((forward as { touched: unknown[] }).touched).toEqual([{ path: '/work/a/x.txt', first_event_id: 10 }]);
  });

  it('meter_records keeps the record of the greatest event id whatever order the runs are repaired in', async () => {
    const forward = await recordsAfter([meteredA, meteredB]);
    const backward = await recordsAfter([meteredB, meteredA]);
    expect(backward).toEqual(forward);
    expect((forward as { meters: { seq: number; first_run: number }[] }).meters).toMatchObject([{ seq: 21, first_run: 0 }]);
  });

  it('applying the same events twice gives the records of applying them once', async () => {
    const once = await recordsAfter([touchedA, meteredA, touchedB, meteredB]);
    const twice = await recordsAfter([touchedA, meteredA, touchedB, meteredB, touchedB, meteredB, touchedA, meteredA]);
    expect(twice).toEqual(once);
  });

  it('the window of misses holds the misses of the greatest event ids, at most the window size', async () => {
    const many = Array.from({ length: ERROR_WINDOW + 5 }, (_unused, index) => (runs: readonly string[], sessionId: string) => meter(100 + ERROR_WINDOW + 5 - index, runs[0] ?? '', sessionId));
    const forward = (await recordsAfter(many)) as { meters: { misses_json: string }[] };
    const backward = (await recordsAfter([...many].reverse())) as { meters: { misses_json: string }[] };
    expect(backward).toEqual(forward);
    const misses: unknown = JSON.parse(forward.meters[0]?.misses_json ?? '[]');
    expect(misses).toHaveLength(ERROR_WINDOW);
    expect((misses as { miss: number }[]).map((entry) => entry.miss).sort((a, b) => a - b)[0]).toBe(106);
  });
});
