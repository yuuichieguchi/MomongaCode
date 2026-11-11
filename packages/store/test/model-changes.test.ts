import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';

const notices = (count: number): RunEventPayload[] => Array.from({ length: count }, (_, index) => ({ type: 'notice', level: 'info', message: `n${index}` }));

describe('readModelChanges', () => {
  it('returns exactly the model.changed events of the session after the given event id, among many unrelated events', async () => {
    const h = harness();
    const session = newSession(h.store);
    await enqueue(h.store, session.id);
    const claim = mustClaim(h.store, 'w1');
    expect(h.store.append(claim, notices(300)).kind).toBe('ok');
    const before = h.store.sessionMaxEventId(session.id);
    h.store.setPermissionMode(session.id, 'plan');
    expect(h.store.append(claim, notices(300)).kind).toBe('ok');
    h.store.setModel(session.id, 'other');
    expect(h.store.append(claim, notices(300)).kind).toBe('ok');
    h.store.setModel(session.id, 'third');
    expect(h.store.append(claim, notices(300)).kind).toBe('ok');

    const changes = h.store.readModelChanges(session.id, before);

    expect(changes.map((event) => [event.type, event.previousModel, event.model])).toEqual([
      ['model.changed', session.model, 'other'],
      ['model.changed', 'other', 'third'],
    ]);
  });

  it('leaves out a switch at or before the given event id and a switch of another session', () => {
    const h = harness();
    const session = newSession(h.store);
    const other = newSession(h.store, '/work/b');
    h.store.setModel(session.id, 'other');
    h.store.setModel(other.id, 'elsewhere');
    const after = h.store.sessionMaxEventId(session.id);
    h.store.setModel(session.id, 'third');

    expect(h.store.readModelChanges(session.id, after).map((event) => event.model)).toEqual(['third']);
    expect(h.store.readModelChanges(session.id, 0).map((event) => event.model)).toEqual(['other', 'third']);
  });

  it('is answered from an index on the session and the event id, not by scanning the events of the session', () => {
    const h = harness();
    newSession(h.store);
    const plan = rawDb(h.dbPath)
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM events WHERE session_id = ? AND type = 'model.changed' AND id > ? ORDER BY id")
      .all('s', 0)
      .map((row) => String(row['detail']))
      .join('\n');
    expect(plan).toContain('events_model_changes');
  });
});
