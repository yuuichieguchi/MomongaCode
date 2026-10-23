import { describe, expect, it } from 'vitest';
import type { PermissionOption } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { START_MS, enqueue, harness, mustClaim, mustRun, newSession } from './helpers.ts';

const OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];
const DIGEST = 'a'.repeat(64);

describe('store.requestApproval with a pre-existing pending approval', () => {
  it('supersedes a pre-existing pending approval without a digest, and the fold follows the new approval', () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'worker-1');
    const appended = store.append(claim, [
      { type: 'tool.call', callId: 'call_1', providerCallId: 'call_1', name: 'Write', kind: 'edit', title: 'Write', rawInput: {} },
    ]);
    if (appended.kind !== 'ok') throw new Error('expected the append to succeed');
    const existing = store.approvals.create({ runId: run.id, callId: 'call_1', options: OPTIONS, expiresAt: START_MS + 60_000 });
    if (existing.kind !== 'ok') throw new Error('expected the pre-existing approval');

    const result = store.requestApproval(claim, { callId: 'call_1', options: OPTIONS, expiresAt: START_MS + 60_000, event: { subjectDigest: DIGEST } });

    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
    expect(result.approval.id).not.toBe(existing.approval.id);
    expect(store.approvals.get(existing.approval.id)?.status).toBe('superseded');
    expect(store.approvals.resolve(existing.approval.id, { optionId: 'allow_once' }).kind).toBe('conflict');
    const fresh = () => initialRunState({ runId: run.id, sessionId: run.sessionId });
    const requests = store.readRunEvents(run.id, 0, 100).filter((event) => event.type === 'tool.permission.requested');
    expect(requests).toEqual([expect.objectContaining({ approvalId: result.approval.id, callId: 'call_1', subjectDigest: DIGEST })]);
    expect(store.readRunEvents(run.id, 0, 100).reduce(foldRunState, fresh()).pendingCalls['call_1']).toMatchObject({
      status: 'awaiting_approval',
      approvalId: result.approval.id,
    });

    expect(store.approvals.resolve(result.approval.id, { optionId: 'allow_once' }).kind).toBe('ok');
    expect(store.release(claim, 'WAITING_HUMAN').kind).toBe('ok');
    const resolved = store.appendAsService(run.id, mustRun(store, run.id).version, 'QUEUED', [
      { type: 'tool.permission.resolved', approvalId: result.approval.id, optionId: 'allow_once' },
    ]);
    expect(resolved.kind).toBe('ok');
    expect(store.readRunEvents(run.id, 0, 100).reduce(foldRunState, fresh()).pendingCalls['call_1']).toMatchObject({
      status: 'requested',
      resolution: { optionId: 'allow_once', kind: 'allow_once', subjectDigest: DIGEST },
    });
  });
});
