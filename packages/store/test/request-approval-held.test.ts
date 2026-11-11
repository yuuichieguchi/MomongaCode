import { describe, expect, it } from 'vitest';
import type { PermissionOption } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import type { Claim, RuntimeStore } from '@momonga/store';
import { enqueue, harness, mustClaim, newSession } from './helpers.ts';
import { TEST_FENCE } from '@momonga/testkit';

const OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];
const DIGEST = 'a'.repeat(64);
const FOOTPRINT = { reads: [], writes: ['local:/work/out.txt'] };
const REASON = 'approval required by rule';

const claimWithCall = async (store: RuntimeStore): Promise<{ runId: string; claim: Claim }> => {
  const session = newSession(store);
  const run = await enqueue(store, session.id);
  const claim = mustClaim(store, 'worker-1');
  const appended = store.append(claim, [{ type: 'tool.call', callId: 'call_1', providerCallId: 'call_1', name: 'Write', kind: 'edit', title: 'Write', rawInput: {} }]);
  if (appended.kind !== 'ok') throw new Error('expected the append to succeed');
  return { runId: run.id, claim };
};

const typesAfterCall = (store: RuntimeStore, runId: string): string[] => {
  const types = store.readRunEvents(runId, 0, 100).map((event) => event.type);
  return types.slice(types.indexOf('tool.call') + 1);
};

describe('store.requestApproval for a held call', () => {
  it('records the approval, the hold and the placeholder result in one write, so no stop can fall between them', async () => {
    const { store } = harness();
    const { runId, claim } = await claimWithCall(store);

    const result = await store.requestApproval(claim, {
      callId: 'call_1',
      options: OPTIONS,
      event: { subjectDigest: DIGEST, reason: REASON, shown: { title: 'approval', input: {} } },
      held: { footprint: FOOTPRINT, placeholder: (approvalId) => `waiting for ${approvalId}` },
    });

    if (result.kind !== 'ok') throw new Error(`expected ok, got ${result.kind}`);
    expect(typesAfterCall(store, runId)).toEqual(['tool.permission.requested', 'tool.held', 'tool.completed']);
    const events = store.readRunEvents(runId, 0, 100);
    expect(events.find((event) => event.type === 'tool.held')).toMatchObject({ callId: 'call_1', approvalId: result.approval.id, reason: REASON, footprint: FOOTPRINT });
    expect(events.find((event) => event.type === 'tool.completed')).toMatchObject({ callId: 'call_1', status: 'failed', output: `waiting for ${result.approval.id}`, denial: { source: 'held', reason: REASON } });
    const state = events.reduce(foldRunState, initialRunState({ runId, sessionId: claim.sessionId, fence: TEST_FENCE }));
    expect(state.heldCalls?.['call_1']).toMatchObject({ approvalId: result.approval.id, name: 'Write', options: OPTIONS, subjectDigest: DIGEST });
    expect(state.pendingCalls['call_1']).toMatchObject({ status: 'completed' });
    expect(store.approvals.listPending(runId)).toHaveLength(1);
  });

  it('records the hold without a placeholder for a call whose result the model already has', async () => {
    const { store } = harness();
    const { runId, claim } = await claimWithCall(store);
    await store.requestApproval(claim, { callId: 'call_1', options: OPTIONS, event: { subjectDigest: DIGEST, reason: REASON, shown: { title: 'approval', input: {} } }, held: { footprint: FOOTPRINT } });
    expect(typesAfterCall(store, runId)).toEqual(['tool.permission.requested', 'tool.held']);
  });

  it('writes nothing a second time for the same request', async () => {
    const { store } = harness();
    const { runId, claim } = await claimWithCall(store);
    const input = { callId: 'call_1', options: OPTIONS, event: { subjectDigest: DIGEST, reason: REASON, shown: { title: 'approval', input: {} } }, held: { footprint: FOOTPRINT, placeholder: (approvalId: string) => `waiting for ${approvalId}` } };
    await store.requestApproval(claim, input);
    await store.requestApproval(claim, input);
    expect(typesAfterCall(store, runId)).toEqual(['tool.permission.requested', 'tool.held', 'tool.completed']);
  });

  it('writes only the approval for a call that is not held, as before', async () => {
    const { store } = harness();
    const { runId, claim } = await claimWithCall(store);
    await store.requestApproval(claim, { callId: 'call_1', options: OPTIONS, event: { subjectDigest: DIGEST, reason: REASON, shown: { title: 'approval', input: {} } } });
    expect(typesAfterCall(store, runId)).toEqual(['tool.permission.requested']);
  });
});
