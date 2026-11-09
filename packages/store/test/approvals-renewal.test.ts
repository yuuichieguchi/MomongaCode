import { describe, expect, it } from 'vitest';
import { harness } from './helpers.ts';
import { awaitingApproval, requestFor } from './approval-fixture.ts';

const resolvedApproval = async () => {
  const { store } = harness();
  const { runId, claim, approvals } = await awaitingApproval(store, [{ callId: 'call_1' }], 'running');
  const [first] = approvals;
  if (first === undefined) throw new Error('expected an approval');
  expect((await store.resolveApproval(first.id, 'allow_once')).kind).toBe('ok');
  return { store, runId, claim, first };
};

describe('requestApproval after the previous approval for the call was resolved', () => {
  it('creates a new pending approval and keeps the resolved one', async () => {
    const { store, runId, claim, first } = await resolvedApproval();

    const renewed = await requestFor(store, claim, 'call_1');

    expect(renewed).toMatchObject({ callId: 'call_1', status: 'pending' });
    expect(renewed.id).not.toBe(first.id);
    expect(store.approvals.listPending(runId).map((approval) => approval.id)).toEqual([renewed.id]);
    expect(store.approvals.get(first.id)).toMatchObject({ status: 'resolved', optionId: 'allow_once' });
  });

  it('returns the existing pending approval on a repeated request instead of creating a second one', async () => {
    const { store, runId, claim } = await resolvedApproval();
    const renewed = await requestFor(store, claim, 'call_1');
    const again = await requestFor(store, claim, 'call_1');
    expect(again.id).toBe(renewed.id);
    expect(store.approvals.listPending(runId)).toHaveLength(1);
  });
});
