import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { PermissionMode, RunEvent, RunEventPayload } from '@momonga/protocol';
import { foldRunState, initialRunState, isFatalStoreError } from '@momonga/store';
import type { Claim, Run, RuntimeStore } from '@momonga/store';
import { LEASE_MS, START_MS, TIMEOUT_MS, cancel, enqueue, harness, mustClaim, mustRun, newSession, payloadOf, rawDb } from './helpers.ts';
import type { Harness, StoreOptions } from './helpers.ts';
import {
  CLOSURE_TEXT,
  MARKER_TEXT,
  assistantItem,
  callItem,
  closureEntry,
  inheritedDigest,
  markerEntry,
  modeChangedText,
  taskItem,
  toolCall,
} from './inherit-fixtures.ts';
import type { InheritedEvent } from './inherit-fixtures.ts';

const LONG_LEASE_MS = 10 * TIMEOUT_MS;
const USAGE = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };

const answer = (text: string, mode: PermissionMode = 'default'): RunEventPayload[] => [
  { type: 'run.started', attempt: 1, now: START_MS, pins: { model: 'fm' }, mode },
  { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { tool_choice: 'auto' } },
  {
    type: 'model.responded',
    step: 1,
    attempt: 1,
    response: { status: 'completed', output: [assistantItem(`m-${text}`, text)], usage: USAGE },
  },
];

const finish = (store: RuntimeStore, claim: Claim, payloads: readonly RunEventPayload[], to: 'COMPLETED' | 'FAILED' = 'COMPLETED'): void => {
  expect(store.append(claim, payloads).kind).toBe('ok');
  expect(store.transition(claim, ['RUNNING'], to, to === 'FAILED' ? { error: { code: 'server_error', message: 'x' } } : undefined).kind).toBe('ok');
};

const createRun = (store: RuntimeStore, sessionId: string, input: string, extra: { history?: 'inherit' | 'fresh'; timeoutMs?: number } = {}): Run => {
  const result = store.createRunAndEnqueue(sessionId, {
    input,
    timeoutMs: extra.timeoutMs ?? TIMEOUT_MS,
    limits: {},
    pins: {},
    ...(extra.history === undefined ? {} : { history: extra.history }),
  });
  if (result.kind !== 'created') throw new Error(`expected a created run, got ${result.kind}`);
  return result.run;
};

const inheritedOf = (store: RuntimeStore, runId: string): RunEvent & InheritedEvent => {
  const found = store.readRunEvents(runId, 0, 1000).filter((event) => event.type === 'context.inherited');
  expect(found).toHaveLength(1);
  return found[0] as RunEvent & InheritedEvent;
};

const thrown = (action: () => unknown): unknown => {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected the action to throw');
};

const inheritanceError = (code: 'previous_run_unreadable' | 'previous_run_inconsistent') => expect.objectContaining({ name: 'InheritanceError', code });

const completedPredecessor = (options: StoreOptions = {}) => {
  const env: Harness = harness({ leaseMs: LONG_LEASE_MS, ...options });
  const session = newSession(env.store);
  const first = enqueue(env.store, session.id, 'Say hello');
  finish(env.store, mustClaim(env.store, 'w1'), answer('hello'));
  return { ...env, session, first };
};

const writable = (dbPath: string): DatabaseSync => {
  const db = rawDb(dbPath);
  db.exec('PRAGMA foreign_keys = OFF');
  return db;
};

describe('inheritContext: the happy path', () => {
  it('appends context.inherited at seq 2 with the predecessor conversation and the current mode', () => {
    const { store, session, first } = completedPredecessor();
    const second = enqueue(store, session.id, 'And again');
    const claim = mustClaim(store, 'w1');
    expect(claim.runId).toBe(second.id);

    expect(store.inheritContext(claim, { mode: 'default' })).toEqual({ kind: 'inherited' });

    const events = store.readRunEvents(second.id, 0, 100);
    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [1, 'user.message'],
      [2, 'context.inherited'],
    ]);
    const history = [
      { seq: 1, item: taskItem('Say hello') },
      { seq: 2, item: assistantItem('m-hello', 'hello') },
    ];
    expect(payloadOf(events[1]!)).toEqual({
      type: 'context.inherited',
      fromRunId: first.id,
      fromLastSeq: mustRun(store, first.id).lastSeq,
      history,
      nextItemSeq: 3,
      evicted: [],
      closures: [],
      markers: [],
      fromMode: 'default',
      mode: 'default',
      digest: inheritedDigest({ history, nextItemSeq: 3, evicted: [], mode: 'default' }),
    });
    expect(mustRun(store, second.id).lastSeq).toBe(2);
    const state = events.reduce(foldRunState, initialRunState({ runId: second.id, sessionId: session.id }));
    expect(state.history).toEqual([...history, { seq: 3, item: taskItem('And again') }]);
    expect(state.taskSeq).toBe(3);
  });

  it('records the mode passed by the Worker and announces a change from the predecessor mode', () => {
    const { store, session } = completedPredecessor();
    const second = enqueue(store, session.id, 'And again');
    expect(store.inheritContext(mustClaim(store, 'w1'), { mode: 'plan' })).toEqual({ kind: 'inherited' });
    const event = inheritedOf(store, second.id);
    expect(event.history.at(-1)).toEqual(markerEntry(3, modeChangedText('default', 'plan')));
    expect(event.markers).toEqual([{ seq: 3, kind: 'mode_changed' }]);
    expect(event.mode).toBe('plan');
    expect(event.fromMode).toBe('default');
  });

  it('returns already on a second call and appends nothing', () => {
    const { store, session } = completedPredecessor();
    const second = enqueue(store, session.id, 'And again');
    const claim = mustClaim(store, 'w1');
    expect(store.inheritContext(claim, { mode: 'default' })).toEqual({ kind: 'inherited' });
    expect(store.inheritContext(claim, { mode: 'plan' })).toEqual({ kind: 'already' });
    expect(store.readRunEvents(second.id, 0, 100)).toHaveLength(2);
  });

  it('returns none for the first run of a session and for a fresh run, and appends nothing', () => {
    const { store } = harness({ leaseMs: LONG_LEASE_MS });
    const session = newSession(store);
    const first = enqueue(store, session.id, 'Say hello');
    const firstClaim = mustClaim(store, 'w1');
    expect(store.inheritContext(firstClaim, { mode: 'default' })).toEqual({ kind: 'none' });
    expect(store.readRunEvents(first.id, 0, 100).map((event) => event.type)).toEqual(['user.message']);
    finish(store, firstClaim, answer('hello'));
    const fresh = createRun(store, session.id, 'Start over', { history: 'fresh' });
    expect(store.inheritContext(mustClaim(store, 'w1'), { mode: 'default' })).toEqual({ kind: 'none' });
    expect(store.readRunEvents(fresh.id, 0, 100).map((event) => event.type)).toEqual(['user.message']);
  });

  it('returns lease_lost for a stale claim and appends nothing', () => {
    const { store, session } = completedPredecessor();
    const second = enqueue(store, session.id, 'And again');
    const claim = mustClaim(store, 'w1');
    expect(store.inheritContext({ ...claim, leaseToken: claim.leaseToken + 1 }, { mode: 'default' })).toEqual({ kind: 'lease_lost' });
    expect(store.readRunEvents(second.id, 0, 100)).toHaveLength(1);
  });

  it('returns conflict when the predecessor is not terminal', () => {
    const { store, session, first, dbPath } = completedPredecessor();
    const second = enqueue(store, session.id, 'And again');
    const claim = mustClaim(store, 'w1');
    writable(dbPath).prepare("UPDATE runs SET status = 'RUNNING' WHERE id = ?").run(first.id);
    expect(store.inheritContext(claim, { mode: 'default' })).toMatchObject({ kind: 'conflict' });
    expect(store.readRunEvents(second.id, 0, 100)).toHaveLength(1);
  });
});

describe('inheritContext: the look-through walk', () => {
  const runningPredecessor = () => {
    const env = harness({ leaseMs: LONG_LEASE_MS });
    const session = newSession(env.store);
    const first = enqueue(env.store, session.id, 'Say hello');
    const firstClaim = mustClaim(env.store, 'w1');
    return { ...env, session, first, firstClaim };
  };

  it('skips a run the user cancelled in the queue: its task is not inherited', () => {
    const { store, session, first, firstClaim } = runningPredecessor();
    const retracted = enqueue(store, session.id, 'Never mind this');
    const third = enqueue(store, session.id, 'Do this instead');
    expect(store.claim('w2')).toBeNull();
    expect(cancel(store, retracted.id).status).toBe('CANCELLED');
    expect(store.claim('w2')).toBeNull();
    finish(store, firstClaim, answer('hello'));
    const claim = mustClaim(store, 'w2');
    expect(claim.runId).toBe(third.id);

    expect(store.inheritContext(claim, { mode: 'default' })).toEqual({ kind: 'inherited' });

    const event = inheritedOf(store, third.id);
    expect(event.fromRunId).toBe(first.id);
    expect(event.history).toEqual([
      { seq: 1, item: taskItem('Say hello') },
      { seq: 2, item: assistantItem('m-hello', 'hello') },
    ]);
    expect(JSON.stringify(event.history)).not.toContain('Never mind this');
  });

  it('keeps the task of a run that timed out in the queue, followed by the unprocessed marker', () => {
    const { store, clock, session, firstClaim } = runningPredecessor();
    const timedOut = createRun(store, session.id, 'Too late', { timeoutMs: 1000 });
    const third = enqueue(store, session.id, 'Now this');
    clock.advance(2000);
    expect(store.expireApprovals(clock.now())).toEqual([timedOut.id]);
    expect(mustRun(store, timedOut.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
    finish(store, firstClaim, answer('hello'));
    const claim = mustClaim(store, 'w2');
    expect(claim.runId).toBe(third.id);

    expect(store.inheritContext(claim, { mode: 'default' })).toEqual({ kind: 'inherited' });

    const event = inheritedOf(store, third.id);
    expect(event.fromRunId).toBe(timedOut.id);
    expect(event.history).toEqual([
      { seq: 1, item: taskItem('Say hello') },
      { seq: 2, item: assistantItem('m-hello', 'hello') },
      { seq: 3, item: taskItem('Too late') },
      markerEntry(4, MARKER_TEXT.unprocessed),
    ]);
    expect(event.markers).toEqual([{ seq: 4, kind: 'unprocessed' }]);
    expect(event.nextItemSeq).toBe(5);
    expect(event.mode).toBe('default');
  });

  it('inherits the base run directly when every run between was cancelled in the queue', () => {
    const { store, session, first, firstClaim } = runningPredecessor();
    const second = enqueue(store, session.id, 'retracted one');
    const third = enqueue(store, session.id, 'retracted two');
    const fourth = enqueue(store, session.id, 'the real one');
    cancel(store, second.id);
    cancel(store, third.id);
    finish(store, firstClaim, answer('hello'));
    const claim = mustClaim(store, 'w2');
    expect(claim.runId).toBe(fourth.id);
    expect(store.inheritContext(claim, { mode: 'default' })).toEqual({ kind: 'inherited' });
    const event = inheritedOf(store, fourth.id);
    expect(event.fromRunId).toBe(first.id);
    expect(event.fromLastSeq).toBe(mustRun(store, first.id).lastSeq);
    expect(event.history.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it('returns conflict when a run read during the walk changed before the write phase', () => {
    const { store, dbPath, session, firstClaim } = runningPredecessor();
    const middle = enqueue(store, session.id, 'retracted');
    const third = enqueue(store, session.id, 'the real one');
    cancel(store, middle.id);
    finish(store, firstClaim, answer('hello'));
    const claim = mustClaim(store, 'w2');
    expect(claim.runId).toBe(third.id);
    const before = mustRun(store, third.id);
    writable(dbPath).exec(`
      CREATE TRIGGER bump_middle_on_fence AFTER UPDATE ON runs WHEN NEW.id = '${third.id}' BEGIN
        INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json)
          SELECT id, session_id, last_seq + 1, 0, lease_token, 0, 'notice', '{"level":"info","message":"late","type":"notice"}'
          FROM runs WHERE id = '${middle.id}';
        UPDATE runs SET last_seq = last_seq + 1 WHERE id = '${middle.id}';
      END;
    `);

    expect(store.inheritContext(claim, { mode: 'default' })).toMatchObject({ kind: 'conflict' });

    expect(store.readRunEvents(third.id, 0, 100).map((event) => event.type)).toEqual(['user.message']);
    expect(mustRun(store, third.id)).toMatchObject({ status: 'RUNNING', lastSeq: before.lastSeq, leaseToken: claim.leaseToken, leaseOwner: 'w2' });
    expect(store.heartbeat(claim)).toMatchObject({ kind: 'ok' });
  });

  it('never makes a later run claimable before the predecessor is terminal', () => {
    const { store, session } = runningPredecessor();
    enqueue(store, session.id, 'waits');
    expect(store.claim('w2')).toBeNull();
  });
});

describe('inheritContext: runs that were never processed', () => {
  it('marks a run that was claimed, requeued and then timed out in the queue as unprocessed', () => {
    const { store, clock, session } = completedPredecessor();
    const requeued = createRun(store, session.id, 'Too late', { timeoutMs: 1000 });
    const third = enqueue(store, session.id, 'Now this');
    const requeuedClaim = mustClaim(store, 'w2');
    expect(requeuedClaim.runId).toBe(requeued.id);
    expect(store.release(requeuedClaim, 'QUEUED').kind).toBe('ok');
    clock.advance(2000);
    expect(store.expireApprovals(clock.now())).toEqual([requeued.id]);
    expect(mustRun(store, requeued.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout', attempts: 1 });
    const claim = mustClaim(store, 'w3');
    expect(claim.runId).toBe(third.id);

    expect(store.inheritContext(claim, { mode: 'default' })).toEqual({ kind: 'inherited' });

    const event = inheritedOf(store, third.id);
    expect(event.history.slice(-2)).toEqual([{ seq: 3, item: taskItem('Too late') }, markerEntry(4, MARKER_TEXT.unprocessed)]);
    expect(event.markers).toEqual([{ seq: 4, kind: 'unprocessed' }]);
  });

  it('contributes nothing for a first run of a session cancelled in the queue', () => {
    const { store } = harness({ leaseMs: LONG_LEASE_MS });
    const session = newSession(store);
    const first = enqueue(store, session.id, 'Never mind');
    const second = enqueue(store, session.id, 'The real one');
    expect(cancel(store, first.id).status).toBe('CANCELLED');
    const claim = mustClaim(store, 'w1');
    expect(claim.runId).toBe(second.id);

    expect(store.inheritContext(claim, { mode: 'default' })).toEqual({ kind: 'inherited' });

    const event = inheritedOf(store, second.id);
    expect(event.fromRunId).toBe(first.id);
    expect(event.history).toEqual([]);
    expect(event.markers).toEqual([]);
    expect(JSON.stringify(event)).not.toContain('Never mind');
  });

  it('contributes nothing for a fresh run cancelled in the queue', () => {
    const { store, session } = completedPredecessor();
    const fresh = createRun(store, session.id, 'Start over', { history: 'fresh' });
    const next = enqueue(store, session.id, 'The real one');
    expect(cancel(store, fresh.id).status).toBe('CANCELLED');
    const claim = mustClaim(store, 'w1');
    expect(claim.runId).toBe(next.id);

    expect(store.inheritContext(claim, { mode: 'default' })).toEqual({ kind: 'inherited' });

    const event = inheritedOf(store, next.id);
    expect(event.fromRunId).toBe(fresh.id);
    expect(event.history).toEqual([]);
    expect(JSON.stringify(event)).not.toContain('Start over');
  });

  it('keeps the inherited conversation and drops only the task of a run whose first claim was cancelling after the inherit append', () => {
    const { store, session, first } = completedPredecessor();
    const second = enqueue(store, session.id, 'Cancelled early');
    const secondClaim = mustClaim(store, 'w1');
    expect(store.inheritContext(secondClaim, { mode: 'default' })).toEqual({ kind: 'inherited' });
    expect(store.requestCancel(second.id)).toMatchObject({ kind: 'ok', run: { status: 'CANCELLING' } });
    expect(store.transition(secondClaim, ['CANCELLING'], 'CANCELLED').kind).toBe('ok');
    const third = enqueue(store, session.id, 'Third');
    const claim = mustClaim(store, 'w1');
    expect(claim.runId).toBe(third.id);

    expect(store.inheritContext(claim, { mode: 'default' })).toEqual({ kind: 'inherited' });

    const event = inheritedOf(store, third.id);
    expect(event.fromRunId).toBe(second.id);
    expect(event.history).toEqual([
      { seq: 1, item: taskItem('Say hello') },
      { seq: 2, item: assistantItem('m-hello', 'hello') },
    ]);
    expect(event.markers).toEqual([]);
    expect(mustRun(store, first.id).status).toBe('COMPLETED');
  });
});

describe('inheritContext: the write phase rechecks', () => {
  it('returns already when context.inherited appears between the read and write phases', () => {
    const { store, dbPath, session } = completedPredecessor();
    const second = enqueue(store, session.id, 'And again');
    const claim = mustClaim(store, 'w1');
    writable(dbPath).exec(`
      CREATE TRIGGER plant_inherited_on_fence AFTER UPDATE ON runs WHEN NEW.id = '${second.id}' BEGIN
        INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json)
          VALUES (NEW.id, NEW.session_id, NEW.last_seq + 1, 0, NEW.lease_token, 0, 'context.inherited', '{"type":"context.inherited"}');
        UPDATE runs SET last_seq = last_seq + 1 WHERE id = NEW.id;
      END;
    `);

    expect(store.inheritContext(claim, { mode: 'default' })).toEqual({ kind: 'already' });

    const rows = rawDb(dbPath).prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'context.inherited'").get(second.id);
    expect(rows?.['n']).toBe(1);
  });
});

describe('inheritContext: predecessors that ended badly', () => {
  it('inherits a dead-lettered predecessor and closes its dangling call', () => {
    const { store, clock } = harness({ maxAttempts: 1 });
    const session = newSession(store);
    const first = enqueue(store, session.id, 'Write it');
    const firstClaim = mustClaim(store, 'w1');
    expect(
      store.append(firstClaim, [
        { type: 'run.started', attempt: 1, now: START_MS, pins: { model: 'fm' }, mode: 'default' },
        { type: 'model.requested', step: 1, attempt: 1, digest: 'd1', body: { tool_choice: 'auto' } },
        { type: 'model.responded', step: 1, attempt: 1, response: { status: 'completed', output: [callItem('c1')], usage: USAGE } },
        toolCall('c1'),
      ]).kind,
    ).toBe('ok');
    const second = enqueue(store, session.id, 'Try again');
    clock.advance(LEASE_MS + 1);
    const claim = mustClaim(store, 'w2');
    expect(claim.runId).toBe(second.id);
    expect(mustRun(store, first.id)).toMatchObject({ status: 'FAILED', deadLetter: true });

    expect(store.inheritContext(claim, { mode: 'default' })).toEqual({ kind: 'inherited' });

    const event = inheritedOf(store, second.id);
    expect(event.history).toEqual([{ seq: 1, item: taskItem('Write it') }, { seq: 2, item: callItem('c1') }, closureEntry(3, 'c1', CLOSURE_TEXT.failed)]);
    expect(event.closures).toEqual([{ callId: 'c1', seq: 3, effect: 'not_executed', announced: true }]);
  });

  it('throws previous_run_unreadable for an undecodable predecessor event and appends nothing', () => {
    const { store, dbPath, session, first } = completedPredecessor();
    const second = enqueue(store, session.id, 'And again');
    const claim = mustClaim(store, 'w1');
    const db = writable(dbPath);
    db.exec('DROP TRIGGER events_reject_update');
    db.prepare(`UPDATE events SET type = 'made.up', payload_json = '{"type":"made.up"}' WHERE run_id = ? AND seq = 2`).run(first.id);

    expect(thrown(() => store.inheritContext(claim, { mode: 'default' }))).toEqual(inheritanceError('previous_run_unreadable'));
    expect(store.readRunEvents(second.id, 0, 100)).toHaveLength(1);
  });

  it('throws previous_run_unreadable for a corrupt predecessor snapshot', () => {
    const { store, dbPath, session, first } = completedPredecessor();
    const db = writable(dbPath);
    db.prepare(`INSERT INTO snapshots (run_id, seq, state_json, created_at) VALUES (?, 1, '{"stateVersion":9,"runId":7}', 0)`).run(first.id);
    enqueue(store, session.id, 'And again');
    const claim = mustClaim(store, 'w1');
    expect(thrown(() => store.inheritContext(claim, { mode: 'default' }))).toEqual(inheritanceError('previous_run_unreadable'));
  });

  it('throws previous_run_unreadable when the predecessor journal does not fold', () => {
    const { store, dbPath, session, first } = completedPredecessor();
    const lastSeq = mustRun(store, first.id).lastSeq;
    const db = writable(dbPath);
    db.prepare(
      `INSERT INTO events (run_id, session_id, seq, step, lease_token, created_at, type, payload_json)
       VALUES (?, ?, ?, 1, 1, 0, 'tool.started', '{"callId":"c_ghost","idemKey":"k","type":"tool.started"}')`,
    ).run(first.id, session.id, lastSeq + 1);
    db.prepare('UPDATE runs SET last_seq = ? WHERE id = ?').run(lastSeq + 1, first.id);
    enqueue(store, session.id, 'And again');
    const claim = mustClaim(store, 'w1');
    expect(thrown(() => store.inheritContext(claim, { mode: 'default' }))).toEqual(inheritanceError('previous_run_unreadable'));
  });

  it.each<[string, (ids: { second: string; other: string; first: string }) => string]>([
    ['a missing predecessor', ({ second }) => `UPDATE runs SET previous_run_id = 'run-missing' WHERE id = '${second}'`],
    ['a predecessor of another session', ({ second, other }) => `UPDATE runs SET previous_run_id = '${other}' WHERE id = '${second}'`],
    ['a predecessor that is not the previous ordinal', ({ second, first }) => `UPDATE runs SET previous_run_id = '${first}', ordinal = 3 WHERE id = '${second}'`],
  ])('throws previous_run_inconsistent for %s', (_label, plant) => {
    const { store, dbPath, session, first } = completedPredecessor();
    const otherSession = newSession(store, '/work/other');
    const other = enqueue(store, otherSession.id, 'elsewhere');
    finish(store, mustClaim(store, 'w9'), answer('elsewhere'));
    const second = enqueue(store, session.id, 'And again');
    const claim = mustClaim(store, 'w1');
    expect(claim.runId).toBe(second.id);
    writable(dbPath).exec(plant({ second: second.id, other: other.id, first: first.id }));

    expect(thrown(() => store.inheritContext(claim, { mode: 'default' }))).toEqual(inheritanceError('previous_run_inconsistent'));
    expect(store.readRunEvents(second.id, 0, 100)).toHaveLength(1);
  });

  it('lets a fatal SQLite error propagate unwrapped', () => {
    const { store, dbPath, session } = completedPredecessor();
    enqueue(store, session.id, 'And again');
    const claim = mustClaim(store, 'w1');
    const raw = new DatabaseSync(dbPath, { defensive: false });
    try {
      raw.exec('PRAGMA writable_schema = ON');
      const version = Number(raw.prepare('PRAGMA schema_version').get()?.['schema_version']);
      raw.prepare("UPDATE sqlite_schema SET sql = 'CREATE TABLE snapshots (run_id TEXT' WHERE type = 'table' AND name = 'snapshots'").run();
      raw.exec(`PRAGMA schema_version = ${version + 1}`);
    } finally {
      raw.close();
    }
    const error = thrown(() => store.inheritContext(claim, { mode: 'default' }));
    expect(isFatalStoreError(error)).toBe(true);
    expect((error as Error).name).not.toBe('InheritanceError');
  });
});

describe('session serialisation', () => {
  it.each(['QUEUED', 'RUNNING', 'WAITING_HUMAN', 'CANCELLING'] as const)('does not make the next run claimable while the predecessor is %s', (status) => {
    const { store, dbPath } = harness({ leaseMs: LONG_LEASE_MS });
    const session = newSession(store);
    const first = enqueue(store, session.id, 'first');
    enqueue(store, session.id, 'second');
    writable(dbPath).prepare("UPDATE runs SET status = ?, available_at = ?, lease_owner = 'someone', lease_expires_at = ? WHERE id = ?").run(status, START_MS + TIMEOUT_MS, START_MS + LONG_LEASE_MS, first.id);
    expect(store.claim('w1')).toBeNull();
  });
});
