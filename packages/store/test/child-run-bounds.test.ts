import { describe, expect, it } from 'vitest';
import { enqueue, harness, mustClaim, mustRun, newSession } from './helpers.ts';

describe('G3 test 3: a child run inherits the limits and the deadline of its parent, so the subagent wait needs no timer of its own', () => {
  it('copies limits and deadlineAt from the parent', () => {
    const h = harness();
    const parent = enqueue(h.store, newSession(h.store).id);
    mustClaim(h.store, 'w-parent');
    const created = h.store.createChildRun({ parentRunId: parent.id, parentCallId: 'call_child', input: 'Child', pins: {}, modelAlias: 'fm' });
    if (created.kind !== 'created') throw new Error(`child run was not created: ${created.kind}`);
    const stored = mustRun(h.store, parent.id);
    expect(created.run.limits).toEqual(stored.limits);
    expect(created.run.deadlineAt).toBe(stored.deadlineAt);
  });
});
