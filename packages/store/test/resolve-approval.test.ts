import { describe, expect, it } from 'vitest';
import { DEADLINE_MS, START_MS, cancel, harness, mustRun, payloadOf, rawDb } from './helpers.ts';
import { OPTIONS, awaitingApproval, requestFor } from './approval-fixture.ts';

describe('store.resolveApproval', () => {
  it('1. returns not_found for an unknown approval', async () => {
    const { store } = harness();
    expect(await store.resolveApproval('nope', 'allow_once')).toEqual({ kind: 'not_found' });
  });

  it('2. returns approval_not_pending naming resolved for a second resolve', async () => {
    const { store } = harness();
    const { approvals } = await awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    const id = approvals[0]?.id ?? '';
    expect((await store.resolveApproval(id, 'allow_once')).kind).toBe('ok');

    expect(await store.resolveApproval(id, 'reject_once')).toMatchObject({ kind: 'approval_not_pending', status: 'resolved', approval: { status: 'resolved', optionId: 'allow_once' } });
    expect(store.approvals.get(id)?.optionId).toBe('allow_once');
  });

  it('2. returns approval_not_pending naming superseded for a superseded approval', async () => {
    const { store } = harness();
    const { claim, approvals } = await awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    await requestFor(store, claim, 'call_1', 'b'.repeat(64));
    expect(await store.resolveApproval(approvals[0]?.id ?? '', 'allow_once')).toMatchObject({ kind: 'approval_not_pending', status: 'superseded', approval: { status: 'superseded' } });
  });

  it('2. returns approval_not_pending naming withdrawn for a withdrawn approval', async () => {
    const { store } = harness();
    const { runId, approvals } = await awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    await cancel(store, runId);
    expect(await store.resolveApproval(approvals[0]?.id ?? '', 'allow_once')).toMatchObject({ kind: 'approval_not_pending', status: 'withdrawn', approval: { status: 'withdrawn' } });
  });

  it('2. never expires a pending approval: a sweep at any time before the run ends leaves it answerable', async () => {
    const { store } = harness();
    const { runId, approvals } = await awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    expect(await store.expireApprovals(DEADLINE_MS - 1, (error: unknown) => { throw error; })).toEqual([]);
    expect(await store.resolveApproval(approvals[0]?.id ?? '', 'allow_once')).toMatchObject({ kind: 'ok', run: { id: runId, status: 'QUEUED' } });
  });

  it('3. returns request_missing for a pending approval without its tool.permission.requested event', async () => {
    const { clock, dbPath, store } = harness();
    const { runId } = await awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    rawDb(dbPath)
      .prepare(
        `INSERT INTO approvals (id, run_id, call_id, status, options_json, option_id, expires_at, created_at, resolved_at, subject_digest)
         VALUES ('appr-orphan', ?, 'call_2', 'pending', ?, NULL, ?, ?, NULL, NULL)`,
      )
      .run(runId, JSON.stringify(OPTIONS), null, START_MS);
    clock.advance(20);
    const lastSeq = mustRun(store, runId).lastSeq;

    expect(await store.resolveApproval('appr-orphan', 'allow_once')).toEqual({ kind: 'request_missing' });

    expect(store.approvals.get('appr-orphan')?.status).toBe('pending');
    expect(mustRun(store, runId)).toMatchObject({ status: 'WAITING_HUMAN', lastSeq });
  });

  it('4. accepts an answer given at any time before the run ends, without a sweep', async () => {
    const { clock, store } = harness();
    const { runId, approvals } = await awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    const id = approvals[0]?.id ?? '';
    clock.set(DEADLINE_MS - 1);

    expect(await store.resolveApproval(id, 'allow_once')).toMatchObject({ kind: 'ok', run: { id: runId, status: 'QUEUED' } });

    expect(store.approvals.get(id)?.status).toBe('resolved');
    expect(store.readRunEvents(runId, 0, 100).map(payloadOf).filter((event) => event['type'] === 'tool.permission.cancelled')).toEqual([]);
  });

  it('5. returns run_cancelled when the run has cancel requested, before checking the option', async () => {
    const { dbPath, store } = harness();
    const { runId, approvals } = await awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    const id = approvals[0]?.id ?? '';
    rawDb(dbPath).prepare('UPDATE runs SET cancel_requested = 1 WHERE id = ?').run(runId);

    expect(await store.resolveApproval(id, 'not-offered')).toEqual({ kind: 'run_cancelled' });
    expect(await store.resolveApproval(id, 'allow_once')).toEqual({ kind: 'run_cancelled' });

    expect(store.approvals.get(id)?.status).toBe('pending');
  });

  it('6. returns option_not_offered for an option the approval did not offer, changing nothing', async () => {
    const { store } = harness();
    const { runId, approvals } = await awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    const id = approvals[0]?.id ?? '';
    const lastSeq = mustRun(store, runId).lastSeq;

    expect(await store.resolveApproval(id, 'allow_always')).toEqual({ kind: 'option_not_offered' });

    expect(store.approvals.get(id)?.status).toBe('pending');
    expect(mustRun(store, runId)).toMatchObject({ status: 'WAITING_HUMAN', lastSeq });
  });

  it('7. resolves, appends tool.permission.resolved and requeues a WAITING_HUMAN run now', async () => {
    const { clock, store } = harness();
    const { runId, approvals } = await awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    const id = approvals[0]?.id ?? '';
    clock.advance(9);

    const result = await store.resolveApproval(id, 'reject_once');

    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
    expect(result.approval).toMatchObject({ id, status: 'resolved', optionId: 'reject_once', resolvedAt: START_MS + 9 });
    expect(result.run).toEqual(mustRun(store, runId));
    expect(result.run).toMatchObject({ status: 'QUEUED', availableAt: START_MS + 9 });
    expect(store.readRunEvents(runId, 0, 100).slice(-2).map(payloadOf)).toEqual([
      { type: 'tool.permission.resolved', approvalId: id, optionId: 'reject_once' },
      { type: 'run.status', from: 'WAITING_HUMAN', to: 'QUEUED' },
    ]);
  });

  it('7. keeps a WAITING_HUMAN run waiting until its last pending approval is resolved', async () => {
    const { store } = harness();
    const { runId, approvals } = await awaitingApproval(store, [{ callId: 'call_1' }, { callId: 'call_2' }], 'waiting');
    const [first, second] = approvals;
    if (first === undefined || second === undefined) throw new Error('expected two approvals');

    const one = await store.resolveApproval(first.id, 'allow_once');
    expect(one).toMatchObject({ kind: 'ok', run: { status: 'WAITING_HUMAN' } });
    expect(store.readRunEvents(runId, 0, 100).at(-1)).toMatchObject({ type: 'tool.permission.resolved', approvalId: first.id });

    const two = await store.resolveApproval(second.id, 'allow_once');
    expect(two).toMatchObject({ kind: 'ok', run: { status: 'QUEUED' } });
  });

  it('7. appends the resolution to a RUNNING run without changing its status', async () => {
    const { store } = harness();
    const { runId, approvals } = await awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    const id = approvals[0]?.id ?? '';

    expect(await store.resolveApproval(id, 'allow_once')).toMatchObject({ kind: 'ok', run: { status: 'RUNNING' } });
    expect(payloadOf(store.readRunEvents(runId, 0, 100).at(-1) ?? {})).toEqual({ type: 'tool.permission.resolved', approvalId: id, optionId: 'allow_once' });
  });
});

describe('store.resolveApproval on a RUNNING run long after the request', () => {
  it('records the answer without changing the status, and the later release requeues the run', async () => {
    const { clock, store } = harness();
    const { runId, claim, approvals } = await awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    const id = approvals[0]?.id ?? '';
    clock.set(DEADLINE_MS - 1);

    expect(await store.resolveApproval(id, 'allow_once')).toMatchObject({ kind: 'ok', run: { status: 'RUNNING' } });
    expect(store.approvals.get(id)?.status).toBe('resolved');

    expect((await store.release(claim, 'WAITING_HUMAN')).kind).toBe('ok');
    expect(mustRun(store, runId).status).toBe('QUEUED');
  });
});
