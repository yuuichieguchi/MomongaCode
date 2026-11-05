import { describe, expect, it } from 'vitest';
import type { RuntimeStore } from '@momonga/store';
import { awaitingApproval } from './approval-fixture.ts';
import { LEASE_MS, enqueue, harness, mustClaim, mustRun, newSession, rawDb } from './helpers.ts';
import { fakePreparer } from './preparer-fixture.ts';

const withPreparer = () => {
  const fake = fakePreparer();
  const h = harness({ preparer: fake.preparer });
  fake.bind(h.store);
  return { ...h, fake };
};

const lastStatusEdge = (store: RuntimeStore, runId: string) => {
  const edge = store.readRunEvents(runId, 0, 1000).filter((event) => event.type === 'run.status').at(-1);
  return edge?.type === 'run.status' ? { from: edge.from, to: edge.to } : undefined;
};

const typesOf = (store: RuntimeStore, runId: string): string[] =>
  store.readRunEvents(runId, 0, 1000).map((event) => (event.type === 'run.status' ? `run.status:${event.to}` : event.type));

describe('a cancel request never terminates a run (O13 b3)', () => {
  it('moves a QUEUED run to CANCELLING with cancel origin QUEUED, synchronously and without asking the preparer', () => {
    const h = withPreparer();
    const run = enqueue(h.store, newSession(h.store).id);
    expect(mustRun(h.store, run.id).cancelOrigin).toBeNull();

    const result = h.store.requestCancel(run.id);

    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toMatchObject({ kind: 'ok', changed: true, run: { status: 'CANCELLING', cancelRequested: true, cancelOrigin: 'QUEUED', leaseOwner: null } });
    expect(lastStatusEdge(h.store, run.id)).toEqual({ from: 'QUEUED', to: 'CANCELLING' });
    expect(typesOf(h.store, run.id)).not.toContain('context.contribution');
    expect(h.fake.requests).toEqual([]);
  });

  it('requestCancel on a WAITING_HUMAN run with a pending approval answers CANCELLING and withdraws the approval', () => {
    const h = withPreparer();
    const { runId, approvals } = awaitingApproval(h.store, [{ callId: 'call_1' }], 'waiting');
    expect(h.store.approvals.listPending(runId)).toHaveLength(1);

    expect(h.store.requestCancel(runId)).toMatchObject({ kind: 'ok', changed: true, run: { status: 'CANCELLING', cancelOrigin: 'WAITING_HUMAN' } });

    expect(h.store.approvals.listPending(runId)).toEqual([]);
    expect(h.store.approvalView(approvals[0]?.id ?? '')?.status).toBe('withdrawn');
    expect(typesOf(h.store, runId).slice(-2)).toEqual(['tool.permission.cancelled', 'run.status:CANCELLING']);
    expect(h.fake.requests).toEqual([]);
  });

  it('records the cancel origin RUNNING for a run cancelled while a worker holds it', () => {
    const h = withPreparer();
    const run = enqueue(h.store, newSession(h.store).id);
    mustClaim(h.store, 'w1');

    expect(h.store.requestCancel(run.id)).toMatchObject({ kind: 'ok', run: { status: 'CANCELLING', cancelOrigin: 'RUNNING' } });
  });

  it('moves a running parent and its queued child to CANCELLING, each with its own origin, measuring nothing and writing no contribution', () => {
    const h = withPreparer();
    const parent = enqueue(h.store, newSession(h.store).id);
    mustClaim(h.store, 'w-parent');
    const created = h.store.createChildRun({ parentRunId: parent.id, parentCallId: 'call_child', input: 'Child', pins: {}, modelAlias: 'fm' });
    if (created.kind !== 'created') throw new Error(`child run was not created: ${created.kind}`);

    h.store.requestCancel(parent.id);

    expect(mustRun(h.store, parent.id)).toMatchObject({ status: 'CANCELLING', cancelOrigin: 'RUNNING' });
    expect(mustRun(h.store, created.run.id)).toMatchObject({ status: 'CANCELLING', cancelOrigin: 'QUEUED' });
    expect(typesOf(h.store, created.run.id)).not.toContain('context.contribution');
    expect(h.fake.requests).toEqual([]);
  });
});

describe('the claim exclusion of sweeper-owned runs', () => {
  it('never claims a CANCELLING run whose cancel origin is QUEUED, and leaves its attempts untouched', () => {
    const h = withPreparer();
    const run = enqueue(h.store, newSession(h.store).id);
    h.store.requestCancel(run.id);

    expect(h.store.claim('w1')).toBeNull();

    expect(mustRun(h.store, run.id)).toMatchObject({ status: 'CANCELLING', leaseOwner: null, attempts: 0 });
  });

  it('never claims a CANCELLING run whose cancel origin is WAITING_HUMAN', () => {
    const h = withPreparer();
    const { runId } = awaitingApproval(h.store, [{ callId: 'call_1' }], 'waiting');
    const attempts = mustRun(h.store, runId).attempts;
    h.store.requestCancel(runId);

    expect(h.store.claim('w2')).toBeNull();

    expect(mustRun(h.store, runId)).toMatchObject({ status: 'CANCELLING', leaseOwner: null, attempts });
  });

  it('still claims a CANCELLING run whose cancel origin is RUNNING once its lease expired', () => {
    const h = withPreparer();
    const run = enqueue(h.store, newSession(h.store).id);
    mustClaim(h.store, 'w1');
    h.store.requestCancel(run.id);
    h.clock.advance(LEASE_MS + 1);

    expect(h.store.claim('w2')).toMatchObject({ runId: run.id, status: 'CANCELLING' });
  });
});

describe('the runs.cancel_origin column', () => {
  it('exists, is NULL for a run that is not CANCELLING, and refuses a value outside QUEUED, WAITING_HUMAN, RUNNING and WAITING_TOOL', () => {
    const h = withPreparer();
    const run = enqueue(h.store, newSession(h.store).id);
    const db = rawDb(h.dbPath);

    const columns = (db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map((column) => column.name);
    expect(columns).toContain('cancel_origin');
    expect(db.prepare('SELECT cancel_origin FROM runs WHERE id = ?').get(run.id)).toEqual({ cancel_origin: null });
    expect(() => db.prepare("UPDATE runs SET cancel_origin = 'COMPLETED' WHERE id = ?").run(run.id)).toThrow(/CHECK/);
    for (const origin of ['QUEUED', 'WAITING_HUMAN', 'RUNNING', 'WAITING_TOOL']) {
      expect(() => db.prepare('UPDATE runs SET cancel_origin = ? WHERE id = ?').run(origin, run.id)).not.toThrow();
    }
  });
});
