import { describe, expect, it } from 'vitest';
import { INDICATOR_DEFINITIONS_VERSION } from '@momonga/protocol';
import { settledEventIdOf } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { enqueue, harness, mustClaim, mustRun, newSession, rawDb } from './helpers.ts';

const startTree = async (store: RuntimeStore): Promise<{ rootId: string; childId: string; childClaim: ReturnType<typeof mustClaim> }> => {
  const root = await enqueue(store, newSession(store).id);
  const rootClaim = mustClaim(store, 'w-root');
  const created = await store.createChildRun({ parentRunId: root.id, parentCallId: 'call_child', input: 'Child', pins: {}, model: 'fm' });
  if (created.kind !== 'created') throw new Error(`child run was not created: ${created.kind}`);
  const childClaim = mustClaim(store, 'w-child');
  expect((await store.transition(rootClaim, ['RUNNING'], 'COMPLETED')).kind).toBe('ok');
  expect(mustRun(store, created.run.id).status).toBe('CANCELLING');
  return { rootId: root.id, childId: created.run.id, childClaim };
};

describe('store-protocol-C09: the facts row of a root is recomputed when a member of its terminal tree ends later', () => {
  it('hands the terminal root out again after a child that was CANCELLING at the root end has ended', async () => {
    const { store } = harness();
    const { rootId, childId, childClaim } = await startTree(store);
    const first = store.runFacts.nextBatch(10);
    expect(first.runIds).toEqual([rootId]);
    store.runFacts.commit({ rows: [], calls: [], unavailable: [rootId], throughEventId: first.throughEventId });

    expect((await store.transition(childClaim, ['CANCELLING'], 'CANCELLED')).kind).toBe('ok');

    expect(store.runFacts.nextBatch(10).runIds).toEqual([childId, rootId]);
  });

  it('never splits a member end from its root recompute when the sweep commits a part of a batch', async () => {
    const { store } = harness();
    const { rootId, childId, childClaim } = await startTree(store);
    const first = store.runFacts.nextBatch(10);
    store.runFacts.commit({ rows: [], calls: [], unavailable: [rootId], throughEventId: first.throughEventId });
    expect((await store.transition(childClaim, ['CANCELLING'], 'CANCELLED')).kind).toBe('ok');

    const batch = store.runFacts.nextBatch(10);
    expect(batch.runIds).toEqual([childId, rootId]);
    store.runFacts.commit({ rows: [], calls: [], unavailable: [childId], throughEventId: settledEventIdOf(batch, 1) });

    expect(store.runFacts.nextBatch(10).runIds).toEqual([childId, rootId]);
    expect(settledEventIdOf(batch, 2)).toBe(batch.throughEventId);
  });

  it('lists a root once when its own end and a member end fall in one batch', async () => {
    const { store } = harness();
    const { rootId, childId, childClaim } = await startTree(store);
    expect((await store.transition(childClaim, ['CANCELLING'], 'CANCELLED')).kind).toBe('ok');

    expect(store.runFacts.nextBatch(10).runIds).toEqual([rootId, childId]);
  });
});

describe('store-protocol-C09: root rows folded under the rule before C09 are folded again', () => {
  const RULE_BEFORE_C09 = 3;

  it('moves the definitions version past the rule before C09, so a cursor of that rule hands the ended root out again', async () => {
    const { dbPath, store } = harness();
    const { rootId, childId, childClaim } = await startTree(store);
    expect((await store.transition(childClaim, ['CANCELLING'], 'CANCELLED')).kind).toBe('ok');
    const batch = store.runFacts.nextBatch(10);
    store.runFacts.commit({ rows: [], calls: [], unavailable: [rootId, childId], throughEventId: batch.throughEventId });
    rawDb(dbPath).prepare('UPDATE facts_cursor SET definitions_version = ?').run(RULE_BEFORE_C09);

    expect(INDICATOR_DEFINITIONS_VERSION).toBeGreaterThan(RULE_BEFORE_C09);
    expect(store.runFacts.nextBatch(10).runIds).toEqual([rootId, childId]);
  });
});
