import { describe, expect, it } from 'vitest';
import { DEADLINE_MS, LEASE_MS, callEvent, enqueue, harness, mustClaim, mustRun, newSession } from './helpers.ts';

const EXPIRES_AT = DEADLINE_MS;

const takeOver = (h: ReturnType<typeof harness>) => {
  const run = enqueue(h.store, newSession(h.store).id);
  const stale = mustClaim(h.store, 'w1');
  h.clock.advance(LEASE_MS + 1);
  const fresh = mustClaim(h.store, 'w2');
  return { run, stale, fresh };
};

describe('facts that specs/tla/RunRecovery.tla relies on', () => {
  it('a holder is stale by lease token: an expired holder that nobody reclaimed can still append', () => {
    const h = harness();
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    h.clock.advance(LEASE_MS + 1);
    expect(h.store.append(claim, [{ type: 'notice', level: 'info', message: 'late' }])).toMatchObject({ kind: 'ok' });
    expect(mustRun(h.store, run.id).lastSeq).toBe(2);
  });

  it('a superseded holder can never append, transition or release', () => {
    const h = harness();
    const { run, stale, fresh } = takeOver(h);
    expect(fresh.leaseToken).toBe(stale.leaseToken + 1);
    expect(h.store.append(stale, [{ type: 'notice', level: 'info', message: 'stale' }])).toEqual({ kind: 'lease_lost' });
    expect(h.store.transition(stale, ['RUNNING'], 'COMPLETED')).toEqual({ kind: 'lease_lost' });
    expect(h.store.release(stale, 'QUEUED')).toEqual({ kind: 'lease_lost' });
    expect(h.store.heartbeat(stale)).toEqual({ kind: 'lease_lost' });
    expect(h.store.readRunEvents(run.id, 0, 100).map((event) => event.type)).toEqual(['user.message']);
  });

  it('the idempotency ledger is not fenced: a superseded holder can still complete a record, and the second completion is refused', () => {
    const h = harness();
    takeOver(h);
    h.store.idempotency.begin('call', { expiresAt: EXPIRES_AT, meta: {} });
    h.store.idempotency.complete('call', { by: 'w1' });
    expect(() => h.store.idempotency.complete('call', { by: 'w2' })).toThrow(/cannot complete idempotency key "call"/);
    expect(h.store.idempotency.get('call')).toEqual({ s: 'COMPLETED', result: { by: 'w1' } });
  });

  it('a terminal run refuses service writes', () => {
    const h = harness();
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    h.store.transition(claim, ['RUNNING'], 'COMPLETED');
    const done = mustRun(h.store, run.id);
    expect(h.store.appendAsService(run.id, done.version, null, [{ type: 'notice', level: 'info', message: 'late' }])).toMatchObject({
      kind: 'conflict',
    });
    expect(mustRun(h.store, run.id)).toEqual(done);
  });

  it('a parent that yields to wait for a child that already finished is requeued, not parked', () => {
    const h = harness();
    const session = newSession(h.store);
    const parent = enqueue(h.store, session.id);
    const parentClaim = mustClaim(h.store, 'w-parent');
    h.store.append(parentClaim, [callEvent('c1')]);
    const created = h.store.createChildRun({ parentRunId: parent.id, parentCallId: 'c1', input: 'task', pins: {} });
    if (created.kind !== 'created') throw new Error(`expected a child run, got ${created.kind}`);
    const childClaim = mustClaim(h.store, 'w-child');
    expect(childClaim.runId).toBe(created.run.id);
    h.store.transition(childClaim, ['RUNNING'], 'COMPLETED');
    const released = h.store.release(parentClaim, 'WAITING_TOOL', DEADLINE_MS, { awaits: { runIds: [created.run.id], jobIds: [] } });
    expect(released).toMatchObject({ kind: 'ok', run: { status: 'QUEUED' } });
  });

  it('a child that finishes while the parent waits wakes the parent in the same transaction', () => {
    const h = harness();
    const session = newSession(h.store);
    const parent = enqueue(h.store, session.id);
    const parentClaim = mustClaim(h.store, 'w-parent');
    const created = h.store.createChildRun({ parentRunId: parent.id, parentCallId: 'c1', input: 'task', pins: {} });
    if (created.kind !== 'created') throw new Error(`expected a child run, got ${created.kind}`);
    h.store.release(parentClaim, 'WAITING_TOOL', DEADLINE_MS, { awaits: { runIds: [created.run.id], jobIds: [] } });
    expect(mustRun(h.store, parent.id).status).toBe('WAITING_TOOL');
    const childClaim = mustClaim(h.store, 'w-child');
    h.store.transition(childClaim, ['RUNNING'], 'FAILED', { error: { code: 'x', message: 'x' } });
    expect(mustRun(h.store, parent.id).status).toBe('QUEUED');
  });

  it('a worker that yields while the run is CANCELLING ends up CANCELLED only through the cancel transition', () => {
    const h = harness();
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    h.store.requestCancel(run.id);
    expect(mustRun(h.store, run.id).status).toBe('CANCELLING');
    expect(h.store.release(claim, 'WAITING_HUMAN')).toMatchObject({ kind: 'conflict' });
    expect(h.store.transition(claim, ['CANCELLING'], 'CANCELLED')).toMatchObject({ kind: 'ok', run: { status: 'CANCELLED' } });
  });
});
