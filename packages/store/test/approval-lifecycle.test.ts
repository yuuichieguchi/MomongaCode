import { describe, expect, it } from 'vitest';
import type { RunStatus } from '@momonga/protocol';
import { DEADLINE_MS, START_MS, cancel, harness, mustRun, payloadOf } from './helpers.ts';
import { EXPIRES_MS, awaitingApproval, requestFor } from './approval-fixture.ts';

const tailPayloads = (events: readonly object[], count: number) => events.slice(-count).map(payloadOf);

describe('tool.permission.cancelled on supersede', () => {
  it('appends the cancelled event for the superseded approval right before the new request', () => {
    const { store } = harness();
    const { runId, claim, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    const [first] = approvals;
    if (first === undefined) throw new Error('expected an approval');

    const second = requestFor(store, claim, 'call_1', EXPIRES_MS, 'b'.repeat(64));

    expect(store.approvals.get(first.id)?.status).toBe('superseded');
    expect(tailPayloads(store.readRunEvents(runId, 0, 100), 2)).toEqual([
      { type: 'tool.permission.cancelled', approvalId: first.id, reason: 'superseded' },
      expect.objectContaining({ type: 'tool.permission.requested', approvalId: second.id, subjectDigest: 'b'.repeat(64) }),
    ]);
  });
});

describe('withdrawal on a terminal transition', () => {
  it.each(['COMPLETED', 'STOPPED', 'FAILED'] as const)('withdraws every pending approval when the worker moves the run to %s', (to: RunStatus) => {
    const { store } = harness();
    const { runId, claim, approvals } = awaitingApproval(store, [{ callId: 'call_1' }, { callId: 'call_2' }], 'running');

    const result = store.transition(claim, ['RUNNING'], to, to === 'STOPPED' ? { stopReason: 'max_steps' } : {});

    expect(result.kind).toBe('ok');
    expect(approvals.map((approval) => store.approvals.get(approval.id)?.status)).toEqual(['withdrawn', 'withdrawn']);
    expect(store.approvals.listPending(runId)).toEqual([]);
    const tail = tailPayloads(store.readRunEvents(runId, 0, 100), 3);
    expect(tail.slice(0, 2)).toEqual(
      expect.arrayContaining(approvals.map((approval) => ({ type: 'tool.permission.cancelled', approvalId: approval.id, reason: 'withdrawn' }))),
    );
    expect(tail[2]).toMatchObject({ type: 'run.status', from: 'RUNNING', to });
  });

  it('leaves resolved approvals untouched when the run completes', () => {
    const { store } = harness();
    const { runId, claim, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    const [approval] = approvals;
    if (approval === undefined) throw new Error('expected an approval');
    expect(store.resolveApproval(approval.id, 'allow_once').kind).toBe('ok');

    store.transition(claim, ['RUNNING'], 'COMPLETED');

    expect(store.approvals.get(approval.id)?.status).toBe('resolved');
    expect(store.readRunEvents(runId, 0, 100).filter((event) => event.type === 'tool.permission.cancelled')).toEqual([]);
  });
});

describe('withdrawal by requestCancel', () => {
  it('withdraws the pending approvals of a RUNNING run before the CANCELLING status', () => {
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

  it('withdraws the pending approvals of a WAITING_HUMAN run before the CANCELLED status', () => {
    const { store } = harness();
    const { runId, approvals } = awaitingApproval(store, [{ callId: 'call_1' }, { callId: 'call_2' }], 'waiting');

    expect(cancel(store, runId).status).toBe('CANCELLED');

    expect(approvals.map((approval) => store.approvals.get(approval.id)?.status)).toEqual(['withdrawn', 'withdrawn']);
    const tail = tailPayloads(store.readRunEvents(runId, 0, 100), 3);
    expect(tail.slice(0, 2)).toEqual(
      expect.arrayContaining(approvals.map((approval) => ({ type: 'tool.permission.cancelled', approvalId: approval.id, reason: 'withdrawn' }))),
    );
    expect(tail[2]).toEqual({ type: 'run.status', from: 'WAITING_HUMAN', to: 'CANCELLED' });
  });
});

describe('expireApprovals', () => {
  it('leaves a WAITING_HUMAN run alone until its approval expires', () => {
    const { store } = harness();
    const { runId, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    const lastSeq = mustRun(store, runId).lastSeq;

    expect(store.expireApprovals(EXPIRES_MS - 1)).toEqual([]);

    expect(mustRun(store, runId)).toMatchObject({ status: 'WAITING_HUMAN', lastSeq });
    expect(store.approvals.get(approvals[0]?.id ?? '')?.status).toBe('pending');
  });

  it('expires the due approval, withdraws the rest, notes it and stops the run with approval_timeout', () => {
    const { store } = harness();
    const { runId, approvals } = awaitingApproval(store, [{ callId: 'call_1' }, { callId: 'call_2', expiresAt: EXPIRES_MS + 60_000 }], 'waiting');
    const [due, later] = approvals;
    if (due === undefined || later === undefined) throw new Error('expected two approvals');
    const before = mustRun(store, runId).lastSeq;

    expect(store.expireApprovals(EXPIRES_MS)).toEqual([runId]);

    expect(store.approvals.get(due.id)?.status).toBe('expired');
    expect(store.approvals.get(later.id)?.status).toBe('withdrawn');
    expect(mustRun(store, runId)).toMatchObject({ status: 'STOPPED', stopReason: 'approval_timeout' });
    const added = store.readRunEvents(runId, before, 100).map(payloadOf);
    expect(added).toHaveLength(4);
    expect(added.slice(0, 3)).toEqual(
      expect.arrayContaining([
        { type: 'tool.permission.cancelled', approvalId: due.id, reason: 'expired' },
        { type: 'tool.permission.cancelled', approvalId: later.id, reason: 'withdrawn' },
        expect.objectContaining({ type: 'notice', message: 'The approval for call_1 expired.' }),
      ]),
    );
    expect(added[3]).toEqual({ type: 'run.status', from: 'WAITING_HUMAN', to: 'STOPPED', reason: 'approval_timeout' });
    expect(store.expireApprovals(EXPIRES_MS + 120_000)).toEqual([]);
  });

  it('stops a WAITING_HUMAN run whose deadline passed with timeout and withdraws its approvals', () => {
    const { store } = harness();
    const { runId, approvals } = awaitingApproval(store, [{ callId: 'call_1', expiresAt: DEADLINE_MS + 60_000 }], 'waiting');
    const [approval] = approvals;
    if (approval === undefined) throw new Error('expected an approval');

    expect(store.expireApprovals(DEADLINE_MS - 1)).toEqual([]);
    expect(store.expireApprovals(DEADLINE_MS)).toEqual([runId]);

    expect(mustRun(store, runId)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
    expect(store.approvals.get(approval.id)?.status).toBe('withdrawn');
    expect(tailPayloads(store.readRunEvents(runId, 0, 100), 2)).toEqual([
      { type: 'tool.permission.cancelled', approvalId: approval.id, reason: 'withdrawn' },
      { type: 'run.status', from: 'WAITING_HUMAN', to: 'STOPPED', reason: 'timeout' },
    ]);
  });

  it('leaves expired approvals of a RUNNING run alone', () => {
    const { store } = harness();
    const { runId, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    const lastSeq = mustRun(store, runId).lastSeq;

    expect(store.expireApprovals(DEADLINE_MS + 1)).toEqual([]);

    expect(store.approvals.get(approvals[0]?.id ?? '')?.status).toBe('pending');
    expect(mustRun(store, runId)).toMatchObject({ status: 'RUNNING', lastSeq });
  });

  it('returns every run it stopped', () => {
    const { store } = harness();
    const first = awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    const second = awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');

    expect([...store.expireApprovals(EXPIRES_MS)].sort()).toEqual([first.runId, second.runId].sort());
  });
});

describe('release invariant', () => {
  it('releases to QUEUED now when the approval was resolved after the worker asked', () => {
    const { clock, store } = harness();
    const { runId, claim, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'running');
    const [approval] = approvals;
    if (approval === undefined) throw new Error('expected an approval');
    expect(store.resolveApproval(approval.id, 'allow_once').kind).toBe('ok');
    expect(mustRun(store, runId).status).toBe('RUNNING');
    clock.advance(5);

    const released = store.release(claim, 'WAITING_HUMAN');

    expect(released.kind).toBe('ok');
    expect(mustRun(store, runId)).toMatchObject({ status: 'QUEUED', availableAt: START_MS + 5, leaseOwner: null });
  });

  it('releases to WAITING_HUMAN while an approval is pending', () => {
    const { store } = harness();
    const { runId } = awaitingApproval(store, [{ callId: 'call_1' }], 'waiting');
    expect(mustRun(store, runId).status).toBe('WAITING_HUMAN');
  });

  it('releases to QUEUED when no approval was ever requested', () => {
    const { store } = harness();
    const { runId, claim } = awaitingApproval(store, [], 'running');
    expect(store.release(claim, 'WAITING_HUMAN').kind).toBe('ok');
    expect(mustRun(store, runId).status).toBe('QUEUED');
  });
});

