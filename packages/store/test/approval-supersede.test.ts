import { describe, expect, it } from 'vitest';
import type { PermissionOption } from '@momonga/protocol';
import type { Claim, RuntimeStore } from '@momonga/store';
import { START_MS, enqueue, harness, mustClaim, newSession } from './helpers.ts';

const OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];
const WIDER: PermissionOption[] = [...OPTIONS, { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' }];
const FIRST = 'a'.repeat(64);
const SECOND = 'b'.repeat(64);
const EXPIRES = START_MS + 60_000;

const setup = () => {
  const { clock, store } = harness();
  const run = enqueue(store, newSession(store).id);
  const claim = mustClaim(store, 'worker-1');
  const appended = store.append(claim, [
    { type: 'tool.call', callId: 'call_1', providerCallId: 'call_1', name: 'Write', kind: 'edit', title: 'Write', rawInput: {} },
  ]);
  if (appended.kind !== 'ok') throw new Error('expected the append to succeed');
  return { clock, store, runId: run.id, claim };
};

const request = (store: RuntimeStore, claim: Claim, options: PermissionOption[], subjectDigest: string) => {
  const result = store.requestApproval(claim, { callId: 'call_1', options, expiresAt: EXPIRES, event: { subjectDigest } });
  if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
  return result.approval;
};

const requestedIds = (store: RuntimeStore, runId: string): string[] =>
  store.readRunEvents(runId, 0, 100).flatMap((event) => (event.type === 'tool.permission.requested' ? [event.approvalId] : []));

describe('approval subject digest and supersede', () => {
  it('stores the subject digest on the approval', () => {
    const { store, claim } = setup();
    const approval = request(store, claim, OPTIONS, FIRST);
    expect(approval.subjectDigest).toBe(FIRST);
    expect(store.approvals.get(approval.id)?.subjectDigest).toBe(FIRST);
  });

  it('reuses the pending approval for the same options and digest without a second event', () => {
    const { store, runId, claim } = setup();
    const first = request(store, claim, OPTIONS, FIRST);
    const again = request(store, claim, OPTIONS, FIRST);
    expect(again.id).toBe(first.id);
    expect(requestedIds(store, runId)).toEqual([first.id]);
  });

  it.each([
    ['a different digest', OPTIONS, SECOND],
    ['different options', WIDER, FIRST],
  ])('supersedes the pending approval for %s and requests a new one', (_label, options, digest) => {
    const { store, runId, claim } = setup();
    const first = request(store, claim, OPTIONS, FIRST);

    const second = request(store, claim, options, digest);

    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ status: 'pending', subjectDigest: digest, options });
    expect(store.approvals.get(first.id)?.status).toBe('superseded');
    expect(requestedIds(store, runId)).toEqual([first.id, second.id]);
    expect(store.approvals.listPending(runId).map((approval) => approval.id)).toEqual([second.id]);
  });

  it('refuses to resolve a superseded approval', () => {
    const { store, claim } = setup();
    const first = request(store, claim, OPTIONS, FIRST);
    request(store, claim, OPTIONS, SECOND);
    expect(store.resolveApproval(first.id, 'allow_once')).toEqual({ kind: 'approval_not_pending', status: 'superseded' });
    expect(store.approvals.get(first.id)).not.toHaveProperty('optionId');
  });

  it('leaves superseded approvals superseded when the pending one expires', () => {
    const { store, runId, claim } = setup();
    const first = request(store, claim, OPTIONS, FIRST);
    const second = request(store, claim, OPTIONS, SECOND);
    expect(store.release(claim, 'WAITING_HUMAN').kind).toBe('ok');

    expect(store.expireApprovals(EXPIRES)).toEqual([runId]);

    expect(store.approvals.get(first.id)?.status).toBe('superseded');
    expect(store.approvals.get(second.id)?.status).toBe('expired');
  });
});
