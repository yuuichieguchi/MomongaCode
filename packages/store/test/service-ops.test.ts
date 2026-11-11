import { describe, expect, expectTypeOf, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { ApprovalStore, ApprovalView, Run, RuntimeStore } from '@momonga/store';
import { TIMEOUT_MS, START_MS, cancel, enqueue, harness, mustClaim, mustRun, newSession, rawDb } from './helpers.ts';
import { foldedRunState } from './run-state-codec.ts';
import { OPTIONS, awaitingApproval } from './approval-fixture.ts';

const digestOf = (body: unknown): string => sha256Hex(canonicalJson(body));

const createRun = async (store: RuntimeStore, sessionId: string, input: string, idempotencyKey?: string, requestDigest?: string) =>
  store.createRunAndEnqueue(sessionId, {
    input,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(requestDigest === undefined ? {} : { requestDigest }),
    timeoutMs: TIMEOUT_MS,
    limits: { maxSteps: 10 },
    pins: { model: 'fm' },
  });

const runColumns = (dbPath: string, runId: string) =>
  rawDb(dbPath).prepare('SELECT request_digest, previous_run_id FROM runs WHERE id = ?').get(runId);

describe('createRunAndEnqueue typed result', () => {
  it('returns created with the run and stores the request digest', async () => {
    const { dbPath, store } = harness();
    const session = newSession(store);
    const digest = digestOf({ input: 'hello' });

    const result = await createRun(store, session.id, 'hello', 'key-1', digest);

    if (result.kind !== 'created') throw new Error(`expected created, got ${result.kind}`);
    expect(result.run).toMatchObject({ sessionId: session.id, ordinal: 1, status: 'QUEUED' });
    expect(runColumns(dbPath, result.run.id)).toEqual({ request_digest: digest, previous_run_id: null });
  });

  it('returns existing with the same run for the same key and digest', async () => {
    const { store } = harness();
    const session = newSession(store);
    const digest = digestOf({ input: 'hello' });
    const first = await createRun(store, session.id, 'hello', 'key-1', digest);
    if (first.kind !== 'created') throw new Error('expected created');

    const again = await createRun(store, session.id, 'hello', 'key-1', digest);

    expect(again).toEqual({ kind: 'existing', run: mustRun(store, first.run.id) });
    expect(store.listRuns(session.id)).toHaveLength(1);
  });

  it('returns key_reused for the same key with a different digest', async () => {
    const { store } = harness();
    const session = newSession(store);
    await createRun(store, session.id, 'hello', 'key-1', digestOf({ input: 'hello' }));

    expect(await createRun(store, session.id, 'bye', 'key-1', digestOf({ input: 'bye' }))).toEqual({ kind: 'key_reused' });
    expect(store.listRuns(session.id)).toHaveLength(1);
  });

  it('returns key_reused when the stored run has a NULL digest', async () => {
    const { store } = harness();
    const session = newSession(store);
    await createRun(store, session.id, 'hello', 'key-1');

    expect(await createRun(store, session.id, 'hello', 'key-1', digestOf({ input: 'hello' }))).toEqual({ kind: 'key_reused' });
  });

  it('scopes keys to the session', async () => {
    const { store } = harness();
    const digest = digestOf({ input: 'hello' });
    const first = await createRun(store, newSession(store).id, 'hello', 'key-1', digest);
    const second = await createRun(store, newSession(store).id, 'hello', 'key-1', digest);
    expect([first.kind, second.kind]).toEqual(['created', 'created']);
  });

  it('returns not_found for an unknown session instead of throwing', async () => {
    const { store } = harness();
    expect(await createRun(store, 'ghost', 'hello')).toEqual({ kind: 'not_found' });
  });

  it('records previous_run_id as the session highest-ordinal earlier run', async () => {
    const { dbPath, store } = harness();
    const session = newSession(store);
    const other = newSession(store);
    const first = await enqueue(store, session.id, 'one');
    await enqueue(store, other.id, 'elsewhere');
    const second = await enqueue(store, session.id, 'two');
    await cancel(store, second.id);
    const third = await enqueue(store, session.id, 'three');

    expect(runColumns(dbPath, first.id)).toMatchObject({ previous_run_id: null });
    expect(runColumns(dbPath, second.id)).toMatchObject({ previous_run_id: first.id });
    expect(runColumns(dbPath, third.id)).toMatchObject({ previous_run_id: second.id });
  });
});

describe('requestCancel typed result', () => {
  it('returns ok with changed for a QUEUED run that becomes CANCELLING', async () => {
    const { store } = harness();
    const run = await enqueue(store, newSession(store).id);
    const result = await store.requestCancel(run.id);
    expect(result).toEqual({ kind: 'ok', changed: true, run: mustRun(store, run.id) });
    expect(mustRun(store, run.id)).toMatchObject({ status: 'CANCELLING', cancelOrigin: 'QUEUED' });
  });

  it('returns ok with changed for a RUNNING run that becomes CANCELLING', async () => {
    const { store } = harness();
    const run = await enqueue(store, newSession(store).id);
    mustClaim(store, 'w1');
    expect(await store.requestCancel(run.id)).toMatchObject({ kind: 'ok', changed: true, run: { status: 'CANCELLING', cancelRequested: true } });
  });

  it('returns ok without a change for a CANCELLING run', async () => {
    const { store } = harness();
    const run = await enqueue(store, newSession(store).id);
    mustClaim(store, 'w1');
    await cancel(store, run.id);
    const before = mustRun(store, run.id);
    expect(await store.requestCancel(run.id)).toEqual({ kind: 'ok', changed: false, run: before });
  });

  it('returns ok without a change for a terminal run and appends nothing', async () => {
    const { store } = harness();
    const run = await enqueue(store, newSession(store).id);
    await store.release(mustClaim(store, 'w1'), 'COMPLETED');
    const before = mustRun(store, run.id);
    expect(await store.requestCancel(run.id)).toEqual({ kind: 'ok', changed: false, run: before });
    expect(mustRun(store, run.id).lastSeq).toBe(before.lastSeq);
  });

  it('returns not_found for an unknown run instead of throwing', async () => {
    const { store } = harness();
    expect(await store.requestCancel('nope')).toEqual({ kind: 'not_found' });
  });
});

describe('setPermissionMode', () => {
  it('updates the session and appends one session-scoped mode.changed event', async () => {
    const { clock, store } = harness();
    const session = newSession(store);
    const run = await enqueue(store, session.id);
    clock.advance(3);

    const result = store.setPermissionMode(session.id, 'plan');

    expect(result).toEqual({ kind: 'ok', changed: true, session: { ...session, permissionMode: 'plan' } });
    expect(store.getSession(session.id)?.permissionMode).toBe('plan');
    const sessionEvents = store.readSessionEvents(session.id, 0, 100);
    expect(sessionEvents.at(-1)).toEqual({ id: expect.any(Number), sessionId: session.id, createdAt: START_MS + 3, type: 'mode.changed', mode: 'plan' });
    expect(store.readRunEvents(run.id, 0, 100).map((event) => event.type)).toEqual(['user.message']);
    expect((await foldedRunState(store, run.id)).lastSeq).toBe(1);
  });

  it('returns ok without a change and appends nothing for the current mode', async () => {
    const { store } = harness();
    const session = newSession(store);
    expect(store.setPermissionMode(session.id, 'manual')).toEqual({ kind: 'ok', changed: false, session });
    expect(store.readSessionEvents(session.id, 0, 100)).toEqual([]);
    expect(store.sessionMaxEventId(session.id)).toBe(0);
  });

  it('returns not_found for an unknown session', async () => {
    const { store } = harness();
    expect(store.setPermissionMode('ghost', 'plan')).toEqual({ kind: 'not_found' });
  });
});

describe('setModel', () => {
  it('updates the session and appends one session-scoped model.changed event naming both models', async () => {
    const { clock, store } = harness();
    const session = newSession(store);
    const run = await enqueue(store, session.id);
    clock.advance(3);

    const result = store.setModel(session.id, 'other');

    expect(result).toEqual({ kind: 'ok', changed: true, session: { ...session, model: 'other' } });
    expect(store.getSession(session.id)?.model).toBe('other');
    expect(store.readSessionEvents(session.id, 0, 100).at(-1)).toEqual({
      id: expect.any(Number),
      sessionId: session.id,
      createdAt: START_MS + 3,
      type: 'model.changed',
      model: 'other',
      previousModel: session.model,
    });
    expect(store.readRunEvents(run.id, 0, 100).map((event) => event.type)).toEqual(['user.message']);
  });

  it('returns ok without a change and appends nothing for the current model', async () => {
    const { store } = harness();
    const session = newSession(store);
    expect(store.setModel(session.id, session.model)).toEqual({ kind: 'ok', changed: false, session });
    expect(store.readSessionEvents(session.id, 0, 100)).toEqual([]);
  });

  it('returns not_found for an unknown session', async () => {
    const { store } = harness();
    expect(store.setModel('ghost', 'other')).toEqual({ kind: 'not_found' });
  });
});

describe('readSessionEvents', () => {
  it('returns run events of every run and session events in global id order', async () => {
    const { store } = harness();
    const session = newSession(store);
    const first = await enqueue(store, session.id, 'one');
    store.setPermissionMode(session.id, 'acceptEdits');
    const second = await enqueue(store, session.id, 'two');

    const events = store.readSessionEvents(session.id, 0, 100);

    expect(events.map((event) => [event.type, 'runId' in event ? event.runId : null])).toEqual([
      ['user.message', first.id],
      ['mode.changed', null],
      ['user.message', second.id],
    ]);
    expect(events.map((event) => event.id)).toEqual([...events.map((event) => event.id)].sort((a, b) => a - b));
    expect(events[1]).not.toHaveProperty('seq');
    expect(events[1]).not.toHaveProperty('leaseToken');
    expect(store.readSessionEvents(session.id, events[1]?.id ?? 0, 100).map((event) => event.type)).toEqual(['user.message']);
    expect(store.sessionMaxEventId(session.id)).toBe(events[2]?.id);
  });

  it('reports 0 as the maximum event id of a session with no events and ignores other sessions', async () => {
    const { store } = harness();
    const empty = newSession(store);
    await enqueue(store, newSession(store).id);
    expect(store.sessionMaxEventId(empty.id)).toBe(0);
  });
});

describe('listRuns', () => {
  it('lists the session runs by ordinal, optionally filtered by status', async () => {
    const { store } = harness();
    const session = newSession(store);
    const first = await enqueue(store, session.id, 'one');
    const second = await enqueue(store, session.id, 'two');
    const third = await enqueue(store, session.id, 'three');
    await enqueue(store, newSession(store).id, 'elsewhere');
    await cancel(store, second.id);
    expect(await store.finishCancelled(() => undefined)).toEqual([second.id]);

    expect(store.listRuns(session.id).map((run: Run) => run.id)).toEqual([first.id, second.id, third.id]);
    expect(store.listRuns(session.id, ['QUEUED']).map((run) => run.id)).toEqual([first.id, third.id]);
    expect(store.listRuns(session.id, ['CANCELLED', 'COMPLETED']).map((run) => run.id)).toEqual([second.id]);
    expect(store.listRuns('ghost')).toEqual([]);
  });
});

describe('approval views', () => {
  it('joins the tool.call event of the call into the view', async () => {
    const { store } = harness();
    const { runId, approvals } = await awaitingApproval(store, [{ callId: 'call_1' }, { callId: 'call_2' }], 'waiting');
    const [first, second] = approvals;
    if (first === undefined || second === undefined) throw new Error('expected two approvals');

    const view = await store.approvalView(first.id);

    const expected: ApprovalView = {
      id: first.id,
      kind: 'permission',
      runId,
      callId: 'call_1',
      status: 'pending',
      options: OPTIONS,
      createdAt: START_MS,
      suggestedRule: 'Write(/work/a/call_1.txt)',
      reason: 'edits require approval',
      toolCall: {
        callId: 'call_1',
        name: 'Write',
        title: 'Write call_1',
        kind: 'edit',
        rawInput: { file_path: '/work/a/call_1.txt' },
        locations: [{ path: '/work/a/call_1.txt' }],
      },
    };
    expect(view).toEqual(expected);
    expect((await store.pendingApprovalViews(runId)).map((entry) => [entry.id, entry.toolCall.callId])).toEqual([
      [first.id, 'call_1'],
      [second.id, 'call_2'],
    ]);
    expect(await store.approvalView('ghost')).toBeUndefined();
  });

  it('drops resolved approvals from the pending views but still shows them by id', async () => {
    const { store } = harness();
    const { runId, approvals } = await awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    const id = approvals[0]?.id ?? '';
    await store.resolveApproval(id, 'allow_once');
    expect(await store.pendingApprovalViews(runId)).toEqual([]);
    expect((await store.approvalView(id))?.status).toBe('resolved');
  });
});

describe('public approval surface', () => {
  it('no longer exposes create or resolve on store.approvals', async () => {
    const { store } = harness();
    expect('create' in store.approvals).toBe(false);
    expect('resolve' in store.approvals).toBe(false);
    expectTypeOf<ApprovalStore>().not.toHaveProperty('create');
    expectTypeOf<ApprovalStore>().not.toHaveProperty('resolve');
  });
});

describe('createRunAndEnqueue deadline', () => {
  it('computes deadlineAt from createdAt and timeoutMs exactly', async () => {
    const { clock, store } = harness();
    const session = newSession(store);
    clock.advance(7);

    const result = await store.createRunAndEnqueue(session.id, { input: 'x', timeoutMs: 12_345, limits: {}, pins: {} });

    if (result.kind !== 'created') throw new Error(`expected created, got ${result.kind}`);
    expect(result.run.createdAt).toBe(START_MS + 7);
    expect(result.run.deadlineAt - result.run.createdAt).toBe(12_345);
  });
});
