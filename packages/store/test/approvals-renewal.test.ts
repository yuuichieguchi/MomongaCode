import { describe, expect, it } from 'vitest';
import type { PermissionOption } from '@momonga/protocol';
import { START_MS, enqueue, harness, newSession } from './helpers.ts';

const OPTIONS: PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
];

const resolvedApproval = () => {
  const { store } = harness();
  const run = enqueue(store, newSession(store).id);
  const created = store.approvals.create({ runId: run.id, callId: 'call_1', options: OPTIONS, expiresAt: START_MS + 60_000 });
  if (created.kind !== 'ok') throw new Error('expected an approval');
  expect(store.approvals.resolve(created.approval.id, { optionId: 'allow_once' }).kind).toBe('ok');
  return { store, runId: run.id, first: created.approval };
};

describe('approvals.create after the previous approval was resolved', () => {
  it('refuses a new approval for the call without renewal', () => {
    const { store, runId } = resolvedApproval();
    const result = store.approvals.create({ runId, callId: 'call_1', options: OPTIONS, expiresAt: START_MS + 60_000 });
    expect(result.kind).toBe('conflict');
    expect(store.approvals.listPending(runId)).toEqual([]);
  });

  it('creates a new pending approval with renewal and keeps the resolved one', () => {
    const { store, runId, first } = resolvedApproval();
    const result = store.approvals.create({ runId, callId: 'call_1', options: OPTIONS, expiresAt: START_MS + 90_000, renewal: true });
    if (result.kind !== 'ok') throw new Error('expected a renewed approval');
    expect(result.approval).toMatchObject({ callId: 'call_1', status: 'pending', expiresAt: START_MS + 90_000 });
    expect(result.approval.id).not.toBe(first.id);
    expect(store.approvals.listPending(runId).map((approval) => approval.id)).toEqual([result.approval.id]);
    expect(store.approvals.get(first.id)).toMatchObject({ status: 'resolved', optionId: 'allow_once' });
  });

  it('returns the existing pending approval on renewal instead of creating a second one', () => {
    const { store, runId } = resolvedApproval();
    const renewed = store.approvals.create({ runId, callId: 'call_1', options: OPTIONS, expiresAt: START_MS + 90_000, renewal: true });
    const again = store.approvals.create({ runId, callId: 'call_1', options: OPTIONS, expiresAt: START_MS + 90_000, renewal: true });
    if (renewed.kind !== 'ok' || again.kind !== 'ok') throw new Error('expected both creates to succeed');
    expect(again.approval.id).toBe(renewed.approval.id);
    expect(store.approvals.listPending(runId)).toHaveLength(1);
  });
});
