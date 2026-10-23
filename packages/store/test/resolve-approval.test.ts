import { describe, expect, it } from 'vitest';
import { START_MS, cancel, harness, mustRun, payloadOf, rawDb } from './helpers.ts';
import { EXPIRES_MS, OPTIONS, awaitingApproval, requestFor } from './approval-fixture.ts';

describe('store.resolveApproval', () => {
  it('1. returns not_found for an unknown approval', () => {
    const { store } = harness();
    expect(store.resolveApproval('nope', 'allow_once')).toEqual({ kind: 'not_found' });
  });

  it('2. returns approval_not_pending naming resolved for a second resolve', () => {
    const { store } = harness();
    const { approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    const id = approvals[0]?.id ?? '';
    expect(store.resolveApproval(id, 'allow_once').kind).toBe('ok');

    expect(store.resolveApproval(id, 'reject_once')).toEqual({ kind: 'approval_not_pending', status: 'resolved' });
    expect(store.approvals.get(id)?.optionId).toBe('allow_once');
  });

  it('2. returns approval_not_pending naming superseded for a superseded approval', () => {
    const { store } = harness();
    const { claim, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    requestFor(store, claim, 'call_1', EXPIRES_MS, 'b'.repeat(64));
    expect(store.resolveApproval(approvals[0]?.id ?? '', 'allow_once')).toEqual({ kind: 'approval_not_pending', status: 'superseded' });
  });

  it('2. returns approval_not_pending naming withdrawn for a withdrawn approval', () => {
    const { store } = harness();
    const { runId, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    cancel(store, runId);
    expect(store.resolveApproval(approvals[0]?.id ?? '', 'allow_once')).toEqual({ kind: 'approval_not_pending', status: 'withdrawn' });
  });

  it('2. returns approval_not_pending naming expired for an approval the sweeper expired', () => {
    const { store } = harness();
    const { approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    store.expireApprovals(EXPIRES_MS);
    expect(store.resolveApproval(approvals[0]?.id ?? '', 'allow_once')).toEqual({ kind: 'approval_not_pending', status: 'expired' });
  });

  it('3. returns request_missing for a pending approval without its tool.permission.requested event, before checking expiry', () => {
    const { clock, dbPath, store } = harness();
    const { runId } = awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    rawDb(dbPath)
      .prepare(
        `INSERT INTO approvals (id, run_id, call_id, status, options_json, option_id, expires_at, created_at, resolved_at, subject_digest)
         VALUES ('appr-orphan', ?, 'call_2', 'pending', ?, NULL, ?, ?, NULL, NULL)`,
      )
      .run(runId, JSON.stringify(OPTIONS), START_MS + 10, START_MS);
    clock.advance(20);
    const lastSeq = mustRun(store, runId).lastSeq;

    expect(store.resolveApproval('appr-orphan', 'allow_once')).toEqual({ kind: 'request_missing' });

    expect(store.approvals.get('appr-orphan')?.status).toBe('pending');
    expect(mustRun(store, runId)).toMatchObject({ status: 'WAITING_HUMAN', lastSeq });
  });

  it('4. expires an approval whose expiry passed without a sweep, stopping the run with approval_timeout', () => {
    const { clock, store } = harness();
    const { runId, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    const id = approvals[0]?.id ?? '';
    clock.set(EXPIRES_MS);
    const before = mustRun(store, runId).lastSeq;

    expect(store.resolveApproval(id, 'allow_once')).toEqual({ kind: 'approval_not_pending', status: 'expired' });

    expect(store.approvals.get(id)?.status).toBe('expired');
    expect(mustRun(store, runId)).toMatchObject({ status: 'STOPPED', stopReason: 'approval_timeout' });
    const added = store.readRunEvents(runId, before, 100).map(payloadOf);
    expect(added.slice(0, 2)).toEqual(
      expect.arrayContaining([
        { type: 'tool.permission.cancelled', approvalId: id, reason: 'expired' },
        expect.objectContaining({ type: 'notice', message: 'The approval for call_1 expired.' }),
      ]),
    );
    expect(added).toHaveLength(3);
    expect(added[2]).toEqual({ type: 'run.status', from: 'WAITING_HUMAN', to: 'STOPPED', reason: 'approval_timeout' });
  });

  it('5. returns run_cancelled when the run has cancel requested, before checking the option', () => {
    const { dbPath, store } = harness();
    const { runId, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    const id = approvals[0]?.id ?? '';
    rawDb(dbPath).prepare('UPDATE runs SET cancel_requested = 1 WHERE id = ?').run(runId);

    expect(store.resolveApproval(id, 'not-offered')).toEqual({ kind: 'run_cancelled' });
    expect(store.resolveApproval(id, 'allow_once')).toEqual({ kind: 'run_cancelled' });

    expect(store.approvals.get(id)?.status).toBe('pending');
  });

  it('6. returns option_not_offered for an option the approval did not offer, changing nothing', () => {
    const { store } = harness();
    const { runId, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    const id = approvals[0]?.id ?? '';
    const lastSeq = mustRun(store, runId).lastSeq;

    expect(store.resolveApproval(id, 'allow_always')).toEqual({ kind: 'option_not_offered' });

    expect(store.approvals.get(id)?.status).toBe('pending');
    expect(mustRun(store, runId)).toMatchObject({ status: 'WAITING_HUMAN', lastSeq });
  });

  it('7. resolves, appends tool.permission.resolved and requeues a WAITING_HUMAN run now', () => {
    const { clock, store } = harness();
    const { runId, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    const id = approvals[0]?.id ?? '';
    clock.advance(9);

    const result = store.resolveApproval(id, 'reject_once');

    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
    expect(result.approval).toMatchObject({ id, status: 'resolved', optionId: 'reject_once', resolvedAt: START_MS + 9 });
    expect(result.run).toEqual(mustRun(store, runId));
    expect(result.run).toMatchObject({ status: 'QUEUED', availableAt: START_MS + 9 });
    expect(store.readRunEvents(runId, 0, 100).slice(-2).map(payloadOf)).toEqual([
      { type: 'tool.permission.resolved', approvalId: id, optionId: 'reject_once' },
      { type: 'run.status', from: 'WAITING_HUMAN', to: 'QUEUED' },
    ]);
  });

  it('7. keeps a WAITING_HUMAN run waiting until its last pending approval is resolved', () => {
    const { store } = harness();
    const { runId, approvals } = awaitingApproval(store, [{ callId: 'call_1' }, { callId: 'call_2' }], 'waiting');
    const [first, second] = approvals;
    if (first === undefined || second === undefined) throw new Error('expected two approvals');

    const one = store.resolveApproval(first.id, 'allow_once');
    expect(one).toMatchObject({ kind: 'ok', run: { status: 'WAITING_HUMAN' } });
    expect(store.readRunEvents(runId, 0, 100).at(-1)).toMatchObject({ type: 'tool.permission.resolved', approvalId: first.id });

    const two = store.resolveApproval(second.id, 'allow_once');
    expect(two).toMatchObject({ kind: 'ok', run: { status: 'QUEUED' } });
  });

  it('7. appends the resolution to a RUNNING run without changing its status', () => {
    const { store } = harness();
    const { runId, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    const id = approvals[0]?.id ?? '';

    expect(store.resolveApproval(id, 'allow_once')).toMatchObject({ kind: 'ok', run: { status: 'RUNNING' } });
    expect(payloadOf(store.readRunEvents(runId, 0, 100).at(-1) ?? {})).toEqual({ type: 'tool.permission.resolved', approvalId: id, optionId: 'allow_once' });
  });
});

describe('store.resolveApproval on an expired approval of a RUNNING run', () => {
  it('reports expired without changing anything, and the later release and sweep stop the run with approval_timeout', () => {
    const { clock, store } = harness();
    const { runId, claim, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    const id = approvals[0]?.id ?? '';
    clock.set(EXPIRES_MS);
    const before = mustRun(store, runId);

    expect(store.resolveApproval(id, 'allow_once')).toEqual({ kind: 'approval_not_pending', status: 'expired' });

    expect(store.approvals.get(id)?.status).toBe('pending');
    expect(mustRun(store, runId)).toMatchObject({ status: 'RUNNING', version: before.version, lastSeq: before.lastSeq });

    expect(store.release(claim, 'WAITING_HUMAN').kind).toBe('ok');
    expect(mustRun(store, runId).status).toBe('WAITING_HUMAN');

    expect(store.expireApprovals(clock.now())).toEqual([runId]);
    expect(store.approvals.get(id)?.status).toBe('expired');
    expect(mustRun(store, runId)).toMatchObject({ status: 'STOPPED', stopReason: 'approval_timeout' });
  });
});
