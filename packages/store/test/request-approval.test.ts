import { describe, expect, it } from 'vitest';
import type { PermissionOption } from '@momonga/protocol';
import type { Claim, RuntimeStore } from '@momonga/store';
import { LEASE_MS, START_MS, enqueue, harness, mustClaim, mustRun, newSession } from './helpers.ts';

const OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];
const DIGEST = 'a'.repeat(64);

const claimWithCall = (store: RuntimeStore): { runId: string; claim: Claim } => {
  const session = newSession(store);
  const run = enqueue(store, session.id);
  const claim = mustClaim(store, 'worker-1');
  const appended = store.append(claim, [
    { type: 'tool.call', callId: 'call_1', providerCallId: 'call_1', name: 'Write', kind: 'edit', title: 'Write', rawInput: {} },
  ]);
  if (appended.kind !== 'ok') throw new Error('expected the append to succeed');
  return { runId: run.id, claim };
};

describe('store.requestApproval', () => {
  it('creates the approval and appends tool.permission.requested in one call', () => {
    const { store } = harness();
    const { runId, claim } = claimWithCall(store);

    const result = store.requestApproval(claim, {
      callId: 'call_1',
      options: OPTIONS,
      event: { subjectDigest: DIGEST, reason: 'edits require approval', suggestedRule: 'Write(/x)' },
    });

    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
    expect(store.approvals.listPending(runId)).toEqual([
      expect.objectContaining({ id: result.approval.id, callId: 'call_1', options: OPTIONS, status: 'pending' }),
    ]);
    const last = store.readRunEvents(runId, 0, 100).at(-1);
    expect(last).toMatchObject({
      type: 'tool.permission.requested',
      approvalId: result.approval.id,
      callId: 'call_1',
      options: OPTIONS,
      subjectDigest: DIGEST,
      suggestedRule: 'Write(/x)',
      leaseToken: claim.leaseToken,
    });
  });

  it('journals the reason the policy asked and reads it back on the event and on the approval view', () => {
    const { store } = harness();
    const { runId, claim } = claimWithCall(store);
    const reason = 'edit outside the workspace requires approval';

    const result = store.requestApproval(claim, {
      callId: 'call_1',
      options: OPTIONS,
      event: { subjectDigest: DIGEST, reason },
    });

    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
    const last = store.readRunEvents(runId, 0, 100).at(-1);
    expect(last).toMatchObject({ type: 'tool.permission.requested', approvalId: result.approval.id, reason });
    expect(store.approvalView(result.approval.id)?.reason).toBe(reason);
    expect(store.pendingApprovalViews(runId).map((view) => view.reason)).toEqual([reason]);
  });

  it('returns lease_lost for a stale claim, creating no approval and appending no event', () => {
    const { clock, store } = harness();
    const { runId, claim } = claimWithCall(store);
    clock.advance(LEASE_MS + 1);
    mustClaim(store, 'worker-2');
    const lastSeq = mustRun(store, runId).lastSeq;

    const result = store.requestApproval(claim, { callId: 'call_1', options: OPTIONS, event: { subjectDigest: DIGEST, reason: 'edits require approval' } });

    expect(result).toEqual({ kind: 'lease_lost' });
    expect(store.approvals.listPending(runId)).toEqual([]);
    expect(mustRun(store, runId).lastSeq).toBe(lastSeq);
    expect(store.readRunEvents(runId, 0, 100).filter((event) => event.type === 'tool.permission.requested')).toEqual([]);
  });

  it('renews the approval once the previous one for the call is resolved', async () => {
    const { store } = harness();
    const { runId, claim } = claimWithCall(store);
    const first = store.requestApproval(claim, { callId: 'call_1', options: OPTIONS, event: { subjectDigest: DIGEST, reason: 'edits require approval' } });
    if (first.kind !== 'ok') throw new Error('expected the first approval');
    expect((await store.resolveApproval(first.approval.id, 'allow_once')).kind).toBe('ok');

    const second = store.requestApproval(claim, { callId: 'call_1', options: OPTIONS, event: { subjectDigest: 'b'.repeat(64), reason: 'edits require approval' } });

    if (second.kind !== 'ok') throw new Error('expected the renewed approval');
    expect(second.approval.id).not.toBe(first.approval.id);
    expect(store.approvals.listPending(runId).map((approval) => approval.id)).toEqual([second.approval.id]);
    expect(store.readRunEvents(runId, 0, 100).filter((event) => event.type === 'tool.permission.requested').map((event) => event.subjectDigest)).toEqual([
      DIGEST,
      'b'.repeat(64),
    ]);
  });
});
