import { describe, expect, it } from 'vitest';
import { DEADLINE_MS, LEASE_MS, START_MS, cancel, enqueue, harness, mustClaim, mustRun, newSession, payloadOf } from './helpers.ts';
import type { Harness } from './helpers.ts';

const takenOverTwice = async ({ clock, store }: Harness) => {
  const run = await enqueue(store, newSession(store).id);
  mustClaim(store, 'w1');
  clock.advance(LEASE_MS + 1);
  mustClaim(store, 'w2');
  clock.advance(LEASE_MS + 1);
  const claim = mustClaim(store, 'w3');
  return { run, claim };
};

describe('release with refundAttempt', () => {
  it('gives back the attempt and resets failed_attempts', async () => {
    const fixture = harness();
    const { run, claim } = await takenOverTwice(fixture);
    expect(mustRun(fixture.store, run.id)).toMatchObject({ attempts: 3, failedAttempts: 2 });

    const result = await fixture.store.release(claim, 'QUEUED', START_MS + 5000, { refundAttempt: true });

    expect(result).toMatchObject({ kind: 'ok', run: { status: 'QUEUED', attempts: 2, failedAttempts: 0, availableAt: START_MS + 5000 } });
    expect(mustRun(fixture.store, run.id)).toMatchObject({ status: 'QUEUED', attempts: 2, failedAttempts: 0, leaseOwner: null });
  });

  it('lets the next claim reuse the refunded attempt number', async () => {
    const { clock, store } = harness();
    const run = await enqueue(store, newSession(store).id);
    const first = mustClaim(store, 'w1');
    expect(first.attempt).toBe(1);
    await store.release(first, 'QUEUED', clock.now(), { refundAttempt: true });
    expect(mustClaim(store, 'w2')).toMatchObject({ runId: run.id, attempt: 1 });
  });
});

describe('releaseLease', () => {
  it('moves a RUNNING run back to QUEUED, clears the lease and sets available_at', async () => {
    const { clock, store } = harness();
    const run = await enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    const before = mustRun(store, run.id);
    clock.advance(10);

    const result = await store.releaseLease(claim, { availableAt: START_MS + 700 });

    expect(result).toMatchObject({ kind: 'ok', run: { status: 'QUEUED' } });
    expect(mustRun(store, run.id)).toMatchObject({
      status: 'QUEUED',
      leaseOwner: null,
      leaseExpiresAt: null,
      availableAt: START_MS + 700,
      attempts: 1,
      failedAttempts: 0,
    });
    expect(store.readRunEvents(run.id, before.lastSeq, 10).map(payloadOf)).toEqual([{ type: 'run.status', from: 'RUNNING', to: 'QUEUED' }]);
    clock.set(START_MS + 699);
    expect(store.claim('w2')).toBeNull();
    clock.set(START_MS + 700);
    expect(mustClaim(store, 'w2')).toMatchObject({ runId: run.id, status: 'RUNNING', attempt: 2 });
  });

  it('refunds the attempt from RUNNING when asked', async () => {
    const fixture = harness();
    const { run, claim } = await takenOverTwice(fixture);

    const result = await fixture.store.releaseLease(claim, { availableAt: fixture.clock.now(), refundAttempt: true });

    expect(result).toMatchObject({ kind: 'ok', run: { status: 'QUEUED', attempts: 2, failedAttempts: 0 } });
    expect(mustClaim(fixture.store, 'w4')).toMatchObject({ runId: run.id, attempt: 3 });
  });

  it('keeps a CANCELLING run CANCELLING with the lease cleared so the next claim takes the cancel path', async () => {
    const { clock, store } = harness();
    const run = await enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    await cancel(store, run.id);
    const before = mustRun(store, run.id);
    expect(before.status).toBe('CANCELLING');

    const result = await store.releaseLease({ ...claim, status: 'CANCELLING' }, { availableAt: START_MS + 300, refundAttempt: true });

    expect(result).toMatchObject({ kind: 'ok', run: { status: 'CANCELLING' } });
    expect(mustRun(store, run.id)).toMatchObject({
      status: 'CANCELLING',
      leaseOwner: null,
      leaseExpiresAt: null,
      availableAt: START_MS + 300,
      cancelRequested: true,
      attempts: 0,
      failedAttempts: 0,
    });
    expect(store.readRunEvents(run.id, before.lastSeq, 10)).toEqual([]);
    clock.set(START_MS + 299);
    expect(store.claim('w2')).toBeNull();
    clock.set(START_MS + 300);
    expect(mustClaim(store, 'w2')).toMatchObject({ runId: run.id, status: 'CANCELLING', attempt: 1 });
    expect(mustRun(store, run.id).failedAttempts).toBe(0);
  });

  it('returns lease_lost for a stale claim and leaves the run alone', async () => {
    const { clock, store } = harness();
    const run = await enqueue(store, newSession(store).id);
    const stale = mustClaim(store, 'w1');
    clock.advance(LEASE_MS + 1);
    const fresh = mustClaim(store, 'w2');
    const before = mustRun(store, run.id);

    expect(await store.releaseLease(stale, { availableAt: clock.now(), refundAttempt: true })).toEqual({ kind: 'lease_lost' });

    expect(mustRun(store, run.id)).toEqual(before);
    expect(await store.releaseLease(fresh, { availableAt: clock.now() })).toMatchObject({ kind: 'ok' });
  });

  it('returns lease_lost once the run has already been released', async () => {
    const { clock, store } = harness();
    await enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    expect(await store.releaseLease(claim, { availableAt: clock.now() })).toMatchObject({ kind: 'ok' });
    expect(await store.releaseLease(claim, { availableAt: clock.now() })).toEqual({ kind: 'lease_lost' });
  });
});

describe('deadline sweep of QUEUED runs', () => {
  it('stops a QUEUED run whose deadline has passed with timeout', async () => {
    const { clock, store } = harness();
    const run = await enqueue(store, newSession(store).id);
    const before = mustRun(store, run.id);

    expect(await store.expireApprovals(DEADLINE_MS - 1, (error: unknown) => { throw error; })).toEqual([]);
    expect(mustRun(store, run.id).status).toBe('QUEUED');

    clock.set(DEADLINE_MS);
    expect(await store.expireApprovals(DEADLINE_MS, (error: unknown) => { throw error; })).toEqual([run.id]);

    expect(mustRun(store, run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout', leaseOwner: null });
    expect(store.readRunEvents(run.id, before.lastSeq, 10).map(payloadOf)).toEqual([
      { type: 'run.status', from: 'QUEUED', to: 'STOPPED', reason: 'timeout' },
    ]);
    expect(store.claim('w1')).toBeNull();
    expect(await store.expireApprovals(DEADLINE_MS + 1, (error: unknown) => { throw error; })).toEqual([]);
  });

  it('stops a requeued run that waits past its deadline but leaves RUNNING runs to their worker', async () => {
    const { clock, store } = harness();
    const requeued = await enqueue(store, newSession(store, '/a').id);
    await store.release(mustClaim(store, 'w1'), 'QUEUED', DEADLINE_MS + 10);
    clock.advance(1);
    const running = await enqueue(store, newSession(store, '/b').id);
    mustClaim(store, 'w2');

    expect(await store.expireApprovals(DEADLINE_MS + 1, (error: unknown) => { throw error; })).toEqual([requeued.id]);

    expect(mustRun(store, requeued.id)).toMatchObject({ status: 'STOPPED', stopReason: 'timeout' });
    expect(mustRun(store, running.id).status).toBe('RUNNING');
  });
});
