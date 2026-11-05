import { describe, expect, it } from 'vitest';
import type { ElicitationRequestView } from '@momonga/protocol';
import type { Claim, RuntimeStore } from '@momonga/store';
import { START_MS, callEvent, cancel, enqueue, harness, mustClaim, mustRun, newSession, payloadOf } from './helpers.ts';
import { awaitingApproval } from './approval-fixture.ts';

const REQUESTS: ElicitationRequestView[] = [
  { key: 'who', mode: 'form', message: 'Who are you?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } },
];
const EXPIRES_MS = START_MS + 60_000;

const asking = (store: RuntimeStore, end: 'running' | 'waiting' = 'waiting'): { runId: string; claim: Claim; id: string } => {
  const session = newSession(store);
  const run = enqueue(store, session.id);
  const claim = mustClaim(store, 'worker-1');
  const appended = store.append(claim, [callEvent('call_1')]);
  if (appended.kind !== 'ok') throw new Error('expected the call to be appended');
  const requested = store.requestElicitation(claim, { callId: 'call_1', expiresAt: EXPIRES_MS, server: 'remote', requests: REQUESTS });
  if (requested.kind !== 'ok') throw new Error('expected an elicitation');
  if (end === 'waiting' && store.release(claim, 'WAITING_HUMAN').kind !== 'ok') throw new Error('expected WAITING_HUMAN');
  return { runId: run.id, claim, id: requested.approval.id };
};

describe('elicitation gates', () => {
  it('announces the request once, even when the worker asks again for the same call', () => {
    const { store } = harness();
    const { runId, claim, id } = asking(store, 'running');
    const again = store.requestElicitation(claim, { callId: 'call_1', expiresAt: EXPIRES_MS, server: 'remote', requests: REQUESTS });
    expect(again).toMatchObject({ kind: 'ok', approval: { id } });
    const requested = store.readRunEvents(runId, 0, 100).map(payloadOf).filter((event) => event['type'] === 'tool.elicitation.requested');
    expect(requested).toEqual([{ type: 'tool.elicitation.requested', inputId: id, callId: 'call_1', server: 'remote', requests: REQUESTS }]);
  });

  it('shows the elicitation through its own view and keeps it out of the approvals the CLI lists', () => {
    const { store } = harness();
    const { runId, id } = asking(store);
    expect(store.pendingApprovalViews(runId)).toEqual([]);
    expect(store.approvalView(id)).toBeUndefined();
    expect(store.pendingElicitationViews(runId)).toMatchObject([{ id, runId, callId: 'call_1', status: 'pending', server: 'remote', requests: REQUESTS, toolCall: { callId: 'call_1', name: 'Write' } }]);
    expect(store.elicitationView(id)?.expiresAt).toBe(EXPIRES_MS);
  });

  it('refuses to resolve an elicitation as an approval and an approval as an elicitation', async () => {
    const { store } = harness();
    const { id } = asking(store);
    expect(await store.resolveApproval(id, 'allow_once')).toEqual({ kind: 'not_found' });
    const { approvals } = awaitingApproval(store, [{ callId: 'call_9' }], 'waiting');
    expect(await store.resolveElicitation(approvals[0]?.id ?? '', {})).toEqual({ kind: 'wrong_kind' });
  });

  it('records the answers, requeues the run and folds the answered call back to started', async () => {
    const { store } = harness();
    const { runId, id } = asking(store);
    const responses = { who: { action: 'accept' as const, content: { name: 'Ada' } } };
    const resolved = await store.resolveElicitation(id, responses);
    expect(resolved).toMatchObject({ kind: 'ok', elicitation: { status: 'resolved', responses }, run: { status: 'QUEUED' } });
    const events = store.readRunEvents(runId, 0, 100).map(payloadOf);
    expect(events.find((event) => event['type'] === 'tool.elicitation.resolved')).toEqual({ type: 'tool.elicitation.resolved', inputId: id, responses });
    expect(await store.resolveElicitation(id, responses)).toEqual({ kind: 'approval_not_pending', status: 'resolved' });
  });

  it('stops the run with approval_timeout when nobody answered in time, never answering for the person', async () => {
    const { store, clock } = harness();
    const { runId, id } = asking(store);
    clock.set(EXPIRES_MS);
    expect(await store.expireApprovals(EXPIRES_MS)).toEqual([runId]);
    expect(mustRun(store, runId)).toMatchObject({ status: 'STOPPED', stopReason: 'approval_timeout' });
    const events = store.readRunEvents(runId, 0, 100).map(payloadOf);
    expect(events).toEqual(expect.arrayContaining([{ type: 'tool.elicitation.cancelled', inputId: id, reason: 'expired' }]));
    expect(events.some((event) => event['type'] === 'tool.elicitation.resolved')).toBe(false);
    expect(await store.resolveElicitation(id, {})).toEqual({ kind: 'approval_not_pending', status: 'expired' });
  });

  it('withdraws the request when the run is cancelled', async () => {
    const { store } = harness();
    const { runId, id } = asking(store);
    cancel(store, runId);
    expect(store.readRunEvents(runId, 0, 100).map(payloadOf)).toEqual(expect.arrayContaining([{ type: 'tool.elicitation.cancelled', inputId: id, reason: 'withdrawn' }]));
    expect(await store.resolveElicitation(id, {})).toEqual({ kind: 'approval_not_pending', status: 'withdrawn' });
  });

  it('refuses an answer for a cancelled run and for an unknown id', async () => {
    const { store } = harness();
    expect(await store.resolveElicitation('nope', {})).toEqual({ kind: 'not_found' });
  });
});

describe('idempotency checkpoint', () => {
  it('stores, replaces and clears the checkpoint of a pending key', () => {
    const { store } = harness();
    enqueue(store, newSession(store).id);
    const ledger = store.idempotency.holding(mustClaim(store, 'worker-1'));
    ledger.begin('k', { expiresAt: START_MS + 1000, meta: { tool: 't' } });
    ledger.checkpoint('k', { kind: 'task', taskId: 'a' });
    ledger.checkpoint('k', { kind: 'task', taskId: 'b' });
    expect(store.idempotency.get('k')).toMatchObject({ s: 'PENDING', rec: { meta: { tool: 't', checkpoint: { kind: 'task', taskId: 'b' } } } });
    store.idempotency.clearCheckpoint('k');
    const lookup = store.idempotency.get('k');
    expect(lookup?.s === 'PENDING' && 'checkpoint' in lookup.rec.meta).toBe(false);
  });

  it('refuses a checkpoint for a key that is not pending', () => {
    const { store } = harness();
    enqueue(store, newSession(store).id);
    const ledger = store.idempotency.holding(mustClaim(store, 'worker-1'));
    ledger.begin('k', { expiresAt: START_MS + 1000, meta: {} });
    ledger.complete('k', { ok: true });
    expect(() => ledger.checkpoint('k', { a: 1 })).toThrow(/no record in state PENDING/);
  });
});
