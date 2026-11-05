import { describe, expect, it } from 'vitest';
import { LEASE_MS, enqueue, harness, mustClaim, mustRun, newSession, rawDb } from './helpers.ts';

type Touched = { runId?: string; sessionId: string }[];

const recorder = () => {
  const calls: Touched[] = [];
  return { calls, onCommit: (touched: Touched) => void calls.push(touched) };
};

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('store onCommit', () => {
  it('fires once after the commit, asynchronously, with the run and session touched', async () => {
    const { calls, onCommit } = recorder();
    const { store } = harness({ onCommit });
    const session = newSession(store);
    await settle();
    calls.length = 0;

    const run = enqueue(store, session.id);

    expect(calls).toEqual([]);
    await settle();
    expect(calls).toEqual([[{ runId: run.id, sessionId: session.id }]]);
  });

  it('deduplicates several events of one op into one entry', async () => {
    const { calls, onCommit } = recorder();
    const { store } = harness({ onCommit });
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    await settle();
    calls.length = 0;

    store.append(claim, [
      { type: 'notice', level: 'info', message: 'one' },
      { type: 'notice', level: 'info', message: 'two' },
      { type: 'notice', level: 'info', message: 'three' },
    ]);
    await settle();

    expect(calls).toEqual([[{ runId: run.id, sessionId: run.sessionId }]]);
  });

  it('reports a session-scoped event without a runId', async () => {
    const { calls, onCommit } = recorder();
    const { store } = harness({ onCommit });
    const session = newSession(store);
    await settle();
    calls.length = 0;

    store.setPermissionMode(session.id, 'plan');
    await settle();

    expect(calls).toEqual([[{ sessionId: session.id }]]);
  });

  it('does not fire for an op that inserts no event', async () => {
    const { calls, onCommit } = recorder();
    const { store } = harness({ onCommit });
    const session = newSession(store);
    const run = enqueue(store, session.id);
    await settle();
    calls.length = 0;

    const claim = mustClaim(store, 'w1');
    store.heartbeat(claim);
    store.getRun(run.id);
    store.setPermissionMode(session.id, 'default');
    await settle();

    expect(calls).toEqual([]);
  });

  it('lets the listener read the committed rows from another connection', async () => {
    const seen: number[] = [];
    const { dbPath, store } = harness({
      onCommit: () => {
        seen.push(Number(rawDb(dbPath).prepare('SELECT COUNT(*) AS n FROM events').get()?.['n']));
      },
    });

    enqueue(store, newSession(store).id);
    await settle();

    expect(seen).toEqual([1]);
  });

  it('fires for the dead-letter run.status appended by the dead-letter sweep', async () => {
    const { calls, onCommit } = recorder();
    const { clock, store } = harness({ onCommit, maxAttempts: 1 });
    const run = enqueue(store, newSession(store).id);
    mustClaim(store, 'w1');
    clock.advance(LEASE_MS + 1);
    await settle();
    calls.length = 0;

    expect(store.claim('w2')).toBeNull();
    expect(await store.deadLetterExhausted(() => undefined)).toEqual([run.id]);

    expect(mustRun(store, run.id)).toMatchObject({ status: 'FAILED', deadLetter: true });
    expect(calls).toEqual([]);
    await settle();
    expect(calls).toEqual([[{ runId: run.id, sessionId: run.sessionId }]]);
  });
});

describe('store onCommit on rollback', () => {
  it('never reports the touches of a rolled-back op, and the next commit reports only its own', async () => {
    const { calls, onCommit } = recorder();
    const { dbPath, store } = harness({ onCommit });
    const failing = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    const otherSession = newSession(store, '/work/b');
    await settle();
    calls.length = 0;
    const db = rawDb(dbPath);
    db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON events WHEN NEW.payload_json LIKE '%second%' BEGIN SELECT RAISE(ABORT, 'injected'); END");

    expect(() =>
      store.append(claim, [
        { type: 'notice', level: 'info', message: 'first' },
        { type: 'notice', level: 'info', message: 'second' },
      ]),
    ).toThrow(/injected/);
    await settle();
    expect(calls).toEqual([]);
    expect(mustRun(store, failing.id).lastSeq).toBe(1);

    db.exec('DROP TRIGGER fail_second');
    const next = enqueue(store, otherSession.id);
    await settle();

    expect(calls).toEqual([[{ runId: next.id, sessionId: otherSession.id }]]);
  });
});
