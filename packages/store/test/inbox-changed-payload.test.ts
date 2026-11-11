import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { TIMEOUT_MS, enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';

const TERMS = { timeoutMs: TIMEOUT_MS, limits: { maxSteps: 10 }, pins: {} };

const SECRET_TEXT = 'the text of a waiting message that no event may hold';

const busySession = async (store: RuntimeStore) => {
  const session = newSession(store);
  await enqueue(store, session.id, 'first');
  mustClaim(store, 'w1');
  return session;
};

const inboxChanges = (store: RuntimeStore, sessionId: string) =>
  store.readSessionEvents(sessionId, 0, 1000).flatMap((event) => (event.type === 'inbox.changed' ? [event.pending] : []));

describe('the payload of inbox.changed', () => {
  it('names each pending row by id, delivery, state and seq, and holds no text', async () => {
    const h = harness();
    const session = await busySession(h.store);
    const first = await h.store.inbox.add(session.id, { delivery: 'queue', text: SECRET_TEXT, run: TERMS });
    const second = await h.store.inbox.add(session.id, { delivery: 'steer', text: `${SECRET_TEXT} again`, run: TERMS });
    if (first.kind !== 'added' || second.kind !== 'added') throw new Error('expected both messages to be added');

    expect(inboxChanges(h.store, session.id)).toEqual([
      [{ id: first.row.id, delivery: 'queue', state: 'pending', seq: 1 }],
      [
        { id: first.row.id, delivery: 'queue', state: 'pending', seq: 1 },
        { id: second.row.id, delivery: 'steer', state: 'pending', seq: 2 },
      ],
    ]);
    const db = rawDb(h.dbPath);
    try {
      const stored = db.prepare("SELECT payload_json FROM events WHERE type = 'inbox.changed'").all().map((row) => String(row['payload_json']));
      expect(stored).toHaveLength(2);
      for (const payload of stored) expect(payload).not.toContain(SECRET_TEXT);
    } finally {
      db.close();
    }
  });

  it('keeps the size of the event independent of the length of the waiting texts', async () => {
    const h = harness();
    const session = await busySession(h.store);
    await h.store.inbox.add(session.id, { delivery: 'queue', text: 'x'.repeat(50_000), run: TERMS });
    const db = rawDb(h.dbPath);
    try {
      const stored = db.prepare("SELECT length(payload_json) AS bytes FROM events WHERE type = 'inbox.changed'").all();
      expect(stored).toHaveLength(1);
      expect(Number(stored[0]?.['bytes'])).toBeLessThan(300);
    } finally {
      db.close();
    }
  });

  it('reads an event an earlier build stored with whole rows as the same four fields', async () => {
    const h = harness();
    const session = await busySession(h.store);
    const earlier = { type: 'inbox.changed', pending: [{ id: 'row-1', sessionId: session.id, delivery: 'queue', text: SECRET_TEXT, seq: 1, state: 'pending', createdAt: 5, settledAt: null }] };
    const db = rawDb(h.dbPath);
    try {
      db.prepare("INSERT INTO events (session_id, created_at, type, payload_json) VALUES (?, 5, 'inbox.changed', ?)").run(session.id, JSON.stringify(earlier));
    } finally {
      db.close();
    }
    expect(inboxChanges(h.store, session.id)).toEqual([[{ id: 'row-1', delivery: 'queue', state: 'pending', seq: 1 }]]);
  });
});
