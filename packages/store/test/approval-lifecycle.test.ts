import { describe, expect, it } from 'vitest';
import type { RunStatus } from '@momonga/protocol';
import { DEADLINE_MS, START_MS, callEvent, cancel, harness, mustRun, payloadOf } from './helpers.ts';
import { EXPIRES_MS, awaitingApproval, awaitingInput, requestFor } from './approval-fixture.ts';

const tailPayloads = (events: readonly object[], count: number) => events.slice(-count).map(payloadOf);

describe('tool.permission.cancelled on supersede', () => {
  it('appends the cancelled event for the superseded approval right before the new request', async () => {
    const { store } = harness();
    const { runId, claim, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    const [first] = approvals;
    if (first === undefined) throw new Error('expected an approval');

    const second = requestFor(store, claim, 'call_1', 'b'.repeat(64));

    expect(store.approvals.get(first.id)?.status).toBe('superseded');
    expect(tailPayloads(store.readRunEvents(runId, 0, 100), 2)).toEqual([
      { type: 'tool.permission.cancelled', approvalId: first.id, reason: 'superseded' },
      expect.objectContaining({ type: 'tool.permission.requested', approvalId: second.id, subjectDigest: 'b'.repeat(64) }),
    ]);
  });
});

describe('withdrawal on a terminal transition', () => {
  it.each(['COMPLETED', 'STOPPED', 'FAILED'] as const)('withdraws every pending approval when the worker moves the run to %s', async (to: RunStatus) => {
    const { store } = harness();
    const { runId, claim, approvals } = awaitingApproval(store, [{ callId: 'call_1' }, { callId: 'call_2' }], 'running');

    const result = (await store.transition(claim, ['RUNNING'], to, to === 'STOPPED' ? { stopReason: 'max_steps' } : {}));

    expect(result.kind).toBe('ok');
    expect(approvals.map((approval) => store.approvals.get(approval.id)?.status)).toEqual(['withdrawn', 'withdrawn']);
    expect(store.approvals.listPending(runId)).toEqual([]);
    const tail = tailPayloads(store.readRunEvents(runId, 0, 100), 3);
    expect(tail.slice(0, 2)).toEqual(
      expect.arrayContaining(approvals.map((approval) => ({ type: 'tool.permission.cancelled', approvalId: approval.id, reason: 'withdrawn' }))),
    );
    expect(tail[2]).toMatchObject({ type: 'run.status', from: 'RUNNING', to });
  });

  it('leaves resolved approvals untouched when the run completes', async () => {
    const { store } = harness();
    const { runId, claim, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    const [approval] = approvals;
    if (approval === undefined) throw new Error('expected an approval');
    expect((await store.resolveApproval(approval.id, 'allow_once')).kind).toBe('ok');

    (await store.transition(claim, ['RUNNING'], 'COMPLETED'));

    expect(store.approvals.get(approval.id)?.status).toBe('resolved');
    expect(store.readRunEvents(runId, 0, 100).filter((event) => event.type === 'tool.permission.cancelled')).toEqual([]);
  });
});

describe('withdrawal by requestCancel', () => {
  it('withdraws the pending approvals of a RUNNING run before the CANCELLING status', async () => {
    const { store } = harness();
    const { runId, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    const [approval] = approvals;
    if (approval === undefined) throw new Error('expected an approval');

    expect(cancel(store, runId).status).toBe('CANCELLING');

    expect(store.approvals.get(approval.id)?.status).toBe('withdrawn');
    expect(tailPayloads(store.readRunEvents(runId, 0, 100), 2)).toEqual([
      { type: 'tool.permission.cancelled', approvalId: approval.id, reason: 'withdrawn' },
      { type: 'run.status', from: 'RUNNING', to: 'CANCELLING' },
    ]);
  });

  it('withdraws the pending approvals of a WAITING_HUMAN run before the CANCELLING status', async () => {
    const { store } = harness();
    const { runId, approvals } = awaitingApproval(store, [{ callId: 'call_1' }, { callId: 'call_2' }], 'waiting');

    expect(cancel(store, runId).status).toBe('CANCELLING');

    expect(approvals.map((approval) => store.approvals.get(approval.id)?.status)).toEqual(['withdrawn', 'withdrawn']);
    const tail = tailPayloads(store.readRunEvents(runId, 0, 100), 3);
    expect(tail.slice(0, 2)).toEqual(
      expect.arrayContaining(approvals.map((approval) => ({ type: 'tool.permission.cancelled', approvalId: approval.id, reason: 'withdrawn' }))),
    );
    expect(tail[2]).toEqual({ type: 'run.status', from: 'WAITING_HUMAN', to: 'CANCELLING' });
  });
});

describe('expireApprovals', () => {
  it('leaves a WAITING_HUMAN run alone until its approval expires', async () => {
    const { store } = harness();
    const { runId, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    const lastSeq = mustRun(store, runId).lastSeq;

    expect((await store.expireApprovals(EXPIRES_MS - 1, (error: unknown) => { throw error; }))).toEqual([]);

    expect(mustRun(store, runId)).toMatchObject({ status: 'WAITING_HUMAN', lastSeq });
    expect(store.approvals.get(approvals[0]?.id ?? '')?.status).toBe('pending');
  });

  it('expires the due request for input, withdraws the pending approval, notes it and stops the run with approval_timeout', async () => {
    const { store } = harness();
    const { runId, claim, approvals } = awaitingInput(store, [{ callId: 'call_1' }], 'running');
    const [due] = approvals;
    if (due === undefined) throw new Error('expected a request for input');
    expect(store.append(claim, [callEvent('call_2')]).kind).toBe('ok');
    const later = requestFor(store, claim, 'call_2');
    expect(store.release(claim, 'WAITING_HUMAN').kind).toBe('ok');
    const before = mustRun(store, runId).lastSeq;

    expect((await store.expireApprovals(EXPIRES_MS, (error: unknown) => { throw error; }))).toEqual([runId]);

    expect(store.approvals.get(due.id)?.status).toBe('expired');
    expect(store.approvals.get(later.id)?.status).toBe('withdrawn');
    expect(mustRun(store, runId)).toMatchObject({ status: 'STOPPED', stopReason: 'approval_timeout' });
    const added = store.readRunEvents(runId, before, 100).map(payloadOf);
    expect(added).toHaveLength(4);
    expect(added.slice(0, 3)).toEqual(
      expect.arrayContaining([
        { type: 'tool.elicitation.cancelled', inputId: due.id, reason: 'expired' },
        { type: 'tool.permission.cancelled', approvalId: later.id, reason: 'withdrawn' },
        expect.objectContaining({ type: 'notice', message: 'The request for input for call_1 expired.' }),
      ]),
    );
    expect(added[3]).toEqual({ type: 'run.status', from: 'WAITING_HUMAN', to: 'STOPPED', reason: 'approval_timeout' });
    expect((await store.expireApprovals(EXPIRES_MS + 120_000, (error: unknown) => { throw error; }))).toEqual([]);
  });

  it('stops a WAITING_HUMAN run whose deadline passed with timeout and withdraws its approvals', async () => {
    const { store } = harness();
    const { runId, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    const [approval] = approvals;
    if (approval === undefined) throw new Error('expected an approval');

    expect((await store.expireApprovals(DEADLINE_MS - 1, (error: unknown) => { throw error; }))).toEqual([]);
    expect((await store.expireApprovals(DEADLINE_MS, (error: unknown) => { throw error; }))).toEqual([runId]);

    expect(mustRun(store, runId)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
    expect(store.approvals.get(approval.id)?.status).toBe('withdrawn');
    expect(tailPayloads(store.readRunEvents(runId, 0, 100), 2)).toEqual([
      { type: 'tool.permission.cancelled', approvalId: approval.id, reason: 'withdrawn' },
      { type: 'run.status', from: 'WAITING_HUMAN', to: 'STOPPED', reason: 'timeout' },
    ]);
  });

  it('leaves expired approvals of a RUNNING run alone', async () => {
    const { store } = harness();
    const { runId, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    const lastSeq = mustRun(store, runId).lastSeq;

    expect((await store.expireApprovals(DEADLINE_MS + 1, (error: unknown) => { throw error; }))).toEqual([]);

    expect(store.approvals.get(approvals[0]?.id ?? '')?.status).toBe('pending');
    expect(mustRun(store, runId)).toMatchObject({ status: 'RUNNING', lastSeq });
  });

  it('returns every run it stopped', async () => {
    const { store } = harness();
    const first = awaitingInput(store, [{ callId: 'call_1' }], 'waiting');
    const second = awaitingInput(store, [{ callId: 'call_1' }], 'waiting');

    expect([...(await store.expireApprovals(EXPIRES_MS, (error: unknown) => { throw error; }))].sort()).toEqual([first.runId, second.runId].sort());
  });
});

describe('release invariant', () => {
  it('releases to QUEUED now when the approval was resolved after the worker asked', async () => {
    const { clock, store } = harness();
    const { runId, claim, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    const [approval] = approvals;
    if (approval === undefined) throw new Error('expected an approval');
    expect((await store.resolveApproval(approval.id, 'allow_once')).kind).toBe('ok');
    expect(mustRun(store, runId).status).toBe('RUNNING');
    clock.advance(5);

    const released = store.release(claim, 'WAITING_HUMAN');

    expect(released.kind).toBe('ok');
    expect(mustRun(store, runId)).toMatchObject({ status: 'QUEUED', availableAt: START_MS + 5, leaseOwner: null });
  });

  it('releases to WAITING_HUMAN while an approval is pending', async () => {
    const { store } = harness();
    const { runId } = awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    expect(mustRun(store, runId).status).toBe('WAITING_HUMAN');
  });

  it('releases to QUEUED when no approval was ever requested', async () => {
    const { store } = harness();
    const { runId, claim } = awaitingApproval(store, [], 'running');
    expect(store.release(claim, 'WAITING_HUMAN').kind).toBe('ok');
    expect(mustRun(store, runId).status).toBe('QUEUED');
  });
});

