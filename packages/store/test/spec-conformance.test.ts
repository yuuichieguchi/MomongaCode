import { describe, expect, it } from 'vitest';
import { DEADLINE_MS, LEASE_MS, START_MS, callEvent, enqueue, harness, mustClaim, mustRun, newSession } from './helpers.ts';

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

  it('a superseded holder can never append, transition or release', async () => {
    const h = harness();
    const { run, stale, fresh } = takeOver(h);
    expect(fresh.leaseToken).toBe(stale.leaseToken + 1);
    expect(h.store.append(stale, [{ type: 'notice', level: 'info', message: 'stale' }])).toEqual({ kind: 'lease_lost' });
    expect(await h.store.transition(stale, ['RUNNING'], 'COMPLETED')).toEqual({ kind: 'lease_lost' });
    expect(h.store.release(stale, 'QUEUED')).toEqual({ kind: 'lease_lost' });
    expect(h.store.heartbeat(stale)).toEqual({ kind: 'lease_lost' });
    expect(h.store.readRunEvents(run.id, 0, 100).map((event) => event.type)).toEqual(['user.message']);
  });

  it('the idempotency ledger is fenced: a superseded holder can neither begin, authorise, attach, checkpoint nor complete', () => {
    const h = harness();
    const { stale, fresh } = takeOver(h);
    const lost = { kind: 'lease_lost' };
    expect(h.store.idempotency.holding(stale).begin('late', { expiresAt: EXPIRES_AT, meta: {} })).toEqual({ s: 'LEASE_LOST' });
    expect(h.store.idempotency.get('late')).toBeUndefined();

    expect(h.store.idempotency.holding(fresh).begin('call', { expiresAt: EXPIRES_AT, meta: {} })).toEqual({ s: 'NEW' });
    const ledger = h.store.idempotency.holding(stale);
    expect(ledger.authorise('call')).toEqual(lost);
    expect(ledger.attachProcess('call', { pgid: 4242, startedAt: START_MS })).toEqual(lost);
    expect(ledger.checkpoint('call', { step: 1 })).toEqual(lost);
    expect(ledger.complete('call', { by: 'w1' })).toEqual(lost);
    expect(h.store.idempotency.get('call')).toMatchObject({ s: 'PENDING', rec: { leaseToken: fresh.leaseToken, meta: {} } });
    const pending = h.store.idempotency.get('call');
    expect(pending?.s === 'PENDING' && pending.rec.pgid).toBe(undefined);
  });

  it('a superseded holder gets lease_lost, not an exception, for a record that the holder has already completed', () => {
    const h = harness();
    const { stale, fresh } = takeOver(h);
    const holder = h.store.idempotency.holding(fresh);
    holder.begin('call', { expiresAt: EXPIRES_AT, meta: {} });
    expect(holder.complete('call', { by: 'w2' })).toEqual({ kind: 'ok' });
    expect(h.store.idempotency.holding(stale).complete('call', { by: 'w1' })).toEqual({ kind: 'lease_lost' });
    expect(() => holder.complete('call', { by: 'w2' })).toThrow(/cannot complete idempotency key "call"/);
    expect(h.store.idempotency.get('call')).toEqual({ s: 'COMPLETED', result: { by: 'w2' } });
  });

  it('a record carries the lease token of the holder that began it and of the holder that last authorised it', () => {
    const h = harness();
    const run = enqueue(h.store, newSession(h.store).id);
    const first = mustClaim(h.store, 'w1');
    h.store.idempotency.holding(first).begin('call', { expiresAt: EXPIRES_AT, meta: {} });
    expect(h.store.idempotency.get('call')).toMatchObject({ rec: { leaseToken: first.leaseToken } });
    h.clock.advance(LEASE_MS + 1);
    const second = mustClaim(h.store, 'w2');
    expect(second.runId).toBe(run.id);
    expect(h.store.idempotency.holding(second).authorise('call')).toEqual({ kind: 'ok' });
    expect(h.store.idempotency.get('call')).toMatchObject({ rec: { leaseToken: second.leaseToken } });
    expect(second.leaseToken).toBe(first.leaseToken + 1);
  });

  it('a holder that released the run is fenced out of the ledger', () => {
    const h = harness();
    enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    expect(h.store.release(claim, 'QUEUED')).toMatchObject({ kind: 'ok' });
    expect(h.store.idempotency.holding(claim).begin('call', { expiresAt: EXPIRES_AT, meta: {} })).toEqual({ s: 'LEASE_LOST' });
  });

  it('the job ledger and the clearing of an abandoned checkpoint are not lease operations', () => {
    const h = harness();
    expect(h.store.idempotency.begin('job', { expiresAt: EXPIRES_AT, meta: {} })).toEqual({ s: 'NEW' });
    expect(h.store.idempotency.get('job')).toMatchObject({ s: 'PENDING' });
    const pending = h.store.idempotency.get('job');
    expect(pending?.s === 'PENDING' && 'leaseToken' in pending.rec).toBe(false);
  });

  it('a terminal run refuses service writes', async () => {
    const h = harness();
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    await h.store.transition(claim, ['RUNNING'], 'COMPLETED');
    const done = mustRun(h.store, run.id);
    expect(h.store.appendAsService(run.id, done.version, null, [{ type: 'notice', level: 'info', message: 'late' }])).toMatchObject({
      kind: 'conflict',
    });
    expect(mustRun(h.store, run.id)).toEqual(done);
  });

  it('a parent that yields to wait for a child that already finished is requeued, not parked', async () => {
    const h = harness();
    const session = newSession(h.store);
    const parent = enqueue(h.store, session.id);
    const parentClaim = mustClaim(h.store, 'w-parent');
    h.store.append(parentClaim, [callEvent('c1')]);
    const created = h.store.createChildRun({ parentRunId: parent.id, parentCallId: 'c1', input: 'task', pins: {}, modelAlias: 'fm' });
    if (created.kind !== 'created') throw new Error(`expected a child run, got ${created.kind}`);
    const childClaim = mustClaim(h.store, 'w-child');
    expect(childClaim.runId).toBe(created.run.id);
    await h.store.transition(childClaim, ['RUNNING'], 'COMPLETED');
    const released = h.store.release(parentClaim, 'WAITING_TOOL', DEADLINE_MS, { awaits: { runIds: [created.run.id], jobIds: [] } });
    expect(released).toMatchObject({ kind: 'ok', run: { status: 'QUEUED' } });
  });

  it('a child that finishes while the parent waits wakes the parent in the same transaction', async () => {
    const h = harness();
    const session = newSession(h.store);
    const parent = enqueue(h.store, session.id);
    const parentClaim = mustClaim(h.store, 'w-parent');
    const created = h.store.createChildRun({ parentRunId: parent.id, parentCallId: 'c1', input: 'task', pins: {}, modelAlias: 'fm' });
    if (created.kind !== 'created') throw new Error(`expected a child run, got ${created.kind}`);
    h.store.release(parentClaim, 'WAITING_TOOL', DEADLINE_MS, { awaits: { runIds: [created.run.id], jobIds: [] } });
    expect(mustRun(h.store, parent.id).status).toBe('WAITING_TOOL');
    const childClaim = mustClaim(h.store, 'w-child');
    await h.store.transition(childClaim, ['RUNNING'], 'FAILED', { error: { code: 'x', message: 'x' } });
    expect(mustRun(h.store, parent.id).status).toBe('QUEUED');
  });

  it('a worker that yields while the run is CANCELLING ends up CANCELLED only through the cancel transition', async () => {
    const h = harness();
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');
    h.store.requestCancel(run.id);
    expect(mustRun(h.store, run.id).status).toBe('CANCELLING');
    expect(h.store.release(claim, 'WAITING_HUMAN')).toMatchObject({ kind: 'conflict' });
    expect(await h.store.transition(claim, ['CANCELLING'], 'CANCELLED')).toMatchObject({ kind: 'ok', run: { status: 'CANCELLED' } });
  });
});
