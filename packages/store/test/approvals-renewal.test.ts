import { describe, expect, it } from 'vitest';
import { START_MS, harness } from './helpers.ts';
import { awaitingApproval, requestFor } from './approval-fixture.ts';

const resolvedApproval = () => {
  const { store } = harness();
  const { runId, claim, approvals } = awaitingApproval(store, [{ callId: 'call_1' }], 'running');
  const [first] = approvals;
  if (first === undefined) throw new Error('expected an approval');
  expect(store.resolveApproval(first.id, 'allow_once').kind).toBe('ok');
  return { store, runId, claim, first };
};

describe('requestApproval after the previous approval for the call was resolved', () => {
  it('creates a new pending approval and keeps the resolved one', () => {
    const { store, runId, claim, first } = resolvedApproval();

    const renewed = requestFor(store, claim, 'call_1', START_MS + 90_000);

    expect(renewed).toMatchObject({ callId: 'call_1', status: 'pending', expiresAt: START_MS + 90_000 });
    expect(renewed.id).not.toBe(first.id);
    expect(store.approvals.listPending(runId).map((approval) => approval.id)).toEqual([renewed.id]);
    expect(store.approvals.get(first.id)).toMatchObject({ status: 'resolved', optionId: 'allow_once' });
  });

  it('returns the existing pending approval on a repeated request instead of creating a second one', () => {
    const { store, runId, claim } = resolvedApproval();
    const renewed = requestFor(store, claim, 'call_1', START_MS + 90_000);
    const again = requestFor(store, claim, 'call_1', START_MS + 90_000);
    expect(again.id).toBe(renewed.id);
    expect(store.approvals.listPending(runId)).toHaveLength(1);
  });
});
