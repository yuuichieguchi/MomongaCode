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
    expect(store.listSessions({ limit: 100, cursor: null }).sessions.map((session) => session.id)).toEqual([a.id, b.id, c.id]);
    expect(store.listSessions({ cwd: '/work/a', limit: 100, cursor: null }).sessions.map((session) => session.id)).toEqual([a.id, c.id]);
  });
});

describe('createRunAndEnqueue', () => {
  it('creates a QUEUED run with its user.message event in one go', async () => {
    const { clock, store } = harness();
    const session = newSession(store);
    clock.advance(10);
    const run = await enqueue(store, session.id, 'fix the bug');
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

  it('numbers ordinals per session', async () => {
    const { store } = harness();
    const s1 = newSession(store, '/a');
    const s2 = newSession(store, '/b');
    expect((await enqueue(store, s1.id)).ordinal).toBe(1);
    expect((await enqueue(store, s1.id)).ordinal).toBe(2);
    expect((await enqueue(store, s2.id)).ordinal).toBe(1);
    expect((await enqueue(store, s1.id)).ordinal).toBe(3);
  });

  it('returns the existing run for a repeated idempotency key in the same session', async () => {
    const { dbPath, store } = harness();
    const session = newSession(store);
    const first = await enqueue(store, session.id, 'once', 'key-1');
    const second = await enqueue(store, session.id, 'once', 'key-1');
    expect(second.id).toBe(first.id);
    const db = rawDb(dbPath);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 });
  });

  it('scopes idempotency keys to the session', async () => {
    const { store } = harness();
    const a = await enqueue(store, newSession(store, '/a').id, 'x', 'key-1');
    const b = await enqueue(store, newSession(store, '/b').id, 'x', 'key-1');
    expect(a.id).not.toBe(b.id);
  });

  it('leaves neither run nor event when the transaction fails midway', async () => {
    const { dbPath, store } = harness();
    const session = newSession(store);
    const db = rawDb(dbPath);
    db.exec("CREATE TRIGGER fail_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await expect(enqueue(store, session.id)).rejects.toThrow(/injected/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 });
    db.exec('DROP TRIGGER fail_events');
    expect((await enqueue(store, session.id)).ordinal).toBe(1);
  });

  it('rejects an unknown session', async () => {
    const { store } = harness();
    expect(
      await store.createRunAndEnqueue('no-such-session', { input: 'x', timeoutMs: 1000, limits: {}, pins: {} }),
    ).toEqual({ kind: 'not_found' });
  });
});

describe('event reads', () => {
  it('pages run events by seq without gaps', async () => {
    const { store } = harness();
    const session = newSession(store);
    const run = await enqueue(store, session.id);
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

  it('pages session events across runs by global id', async () => {
    const { store } = harness();
    const session = newSession(store);
    const other = newSession(store, '/other');
    const r1 = await enqueue(store, session.id, 'one');
    await enqueue(store, other.id, 'elsewhere');
    const r2 = await enqueue(store, session.id, 'two');
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
