import { describe, expect, it } from 'vitest';
import { START_MS, enqueue, harness, mustRun, newSession, rawDb } from './helpers.ts';

describe('sessions', () => {
  it('creates, gets and lists sessions, filtered by cwd', () => {
    const { clock, store } = harness();
    const a = newSession(store, '/work/a');
    clock.advance(1);
    const b = newSession(store, '/work/b');
    clock.advance(1);
    const c = newSession(store, '/work/a');
    expect(a).toMatchObject({
      cwd: '/work/a',
      env: { PATH: '/usr/bin' },
      permissionMode: 'manual',
      model: 'fm',
      createdAt: START_MS,
    });
    expect(a.id).not.toBe(b.id);
    expect(store.getSession(b.id)).toEqual(b);
    expect(store.getSession('missing')).toBeUndefined();
    expect(store.listSessions().map((session) => session.id)).toEqual([a.id, b.id, c.id]);
    expect(store.listSessions({ cwd: '/work/a' }).map((session) => session.id)).toEqual([a.id, c.id]);
  });
});

describe('createRunAndEnqueue', () => {
  it('creates a QUEUED run with its user.message event in one go', () => {
    const { clock, store } = harness();
    const session = newSession(store);
    clock.advance(10);
    const run = enqueue(store, session.id, 'fix the bug');
    expect(run).toMatchObject({
      sessionId: session.id,
      status: 'QUEUED',
      ordinal: 1,
      availableAt: START_MS + 10,
      createdAt: START_MS + 10,
      attempts: 0,
      leaseToken: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      cancelRequested: false,
      deadLetter: false,
      deadlineAt: START_MS + 10 + 3_600_000,
      limits: { maxSteps: 10 },
      pins: { model: 'fm' },
      step: 0,
      lastSeq: 1,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    expect(mustRun(store, run.id)).toEqual(run);
    const events = store.readRunEvents(run.id, 0, 100);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'user.message',
      text: 'fix the bug',
      runId: run.id,
      sessionId: session.id,
      seq: 1,
      step: 0,
      leaseToken: 0,
      createdAt: START_MS + 10,
    });
  });

  it('numbers ordinals per session', () => {
    const { store } = harness();
    const s1 = newSession(store, '/a');
    const s2 = newSession(store, '/b');
    expect(enqueue(store, s1.id).ordinal).toBe(1);
    expect(enqueue(store, s1.id).ordinal).toBe(2);
    expect(enqueue(store, s2.id).ordinal).toBe(1);
    expect(enqueue(store, s1.id).ordinal).toBe(3);
  });

  it('returns the existing run for a repeated idempotency key in the same session', () => {
    const { dbPath, store } = harness();
    const session = newSession(store);
    const first = enqueue(store, session.id, 'once', 'key-1');
    const second = enqueue(store, session.id, 'once', 'key-1');
    expect(second.id).toBe(first.id);
    const db = rawDb(dbPath);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
  });

  it('scopes idempotency keys to the session', () => {
    const { store } = harness();
    const a = enqueue(store, newSession(store, '/a').id, 'x', 'key-1');
    const b = enqueue(store, newSession(store, '/b').id, 'x', 'key-1');
    expect(a.id).not.toBe(b.id);
  });

  it('leaves neither run nor event when the transaction fails midway', () => {
    const { dbPath, store } = harness();
    const session = newSession(store);
    const db = rawDb(dbPath);
    db.exec("CREATE TRIGGER fail_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect(() => enqueue(store, session.id)).toThrow(/injected/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
    db.exec('DROP TRIGGER fail_events');
    expect(enqueue(store, session.id).ordinal).toBe(1);
  });

  it('rejects an unknown session', () => {
    const { store } = harness();
    expect(
      store.createRunAndEnqueue('no-such-session', { input: 'x', timeoutMs: 1000, limits: {}, pins: {} }),
    ).toEqual({ kind: 'not_found' });
  });
});

describe('event reads', () => {
  it('pages run events by seq without gaps', async () => {
    const { store } = harness();
    const session = newSession(store);
    const run = enqueue(store, session.id);
    for (let index = 0; index < 6; index += 1) {
      const current = mustRun(store, run.id);
      const result = store.appendAsService(run.id, current.version, null, [{ type: 'notice', level: 'info', message: `n${index}` }]);
      expect((await result).kind).toBe('ok');
    }
    const page1 = store.readRunEvents(run.id, 0, 3);
    const page2 = store.readRunEvents(run.id, 3, 3);
    const page3 = store.readRunEvents(run.id, 6, 3);
    expect(page1.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(page2.map((event) => event.seq)).toEqual([4, 5, 6]);
    expect(page3.map((event) => event.seq)).toEqual([7]);
    expect(store.readRunEvents(run.id, 7, 3)).toEqual([]);
  });

  it('pages session events across runs by global id', () => {
    const { store } = harness();
    const session = newSession(store);
    const other = newSession(store, '/other');
    const r1 = enqueue(store, session.id, 'one');
    enqueue(store, other.id, 'elsewhere');
    const r2 = enqueue(store, session.id, 'two');
    const all = store.readSessionEvents(session.id, 0, 100);
    expect(all.map((event) => ('runId' in event ? [event.runId, event.seq] : []))).toEqual([
      [r1.id, 1],
      [r2.id, 1],
    ]);
    expect(all[1]!.id).toBeGreaterThan(all[0]!.id);
    expect(store.readSessionEvents(session.id, all[0]!.id, 100).map((event) => ('runId' in event ? event.runId : null))).toEqual([r2.id]);
    expect(store.readSessionEvents(session.id, 0, 1)).toHaveLength(1);
  });
});
