import { describe, expect, it } from 'vitest';
import { enqueue, harness, mustClaim, mustRun, newSession, rawDb } from './helpers.ts';

describe('releaseLease source status', () => {
  it('returns lease_lost when the leased run is neither RUNNING nor CANCELLING', async () => {
    const { clock, dbPath, store } = harness();
    const run = await enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    rawDb(dbPath).prepare("UPDATE runs SET status = 'WAITING_TOOL' WHERE id = ?").run(run.id);
    const before = mustRun(store, run.id);

    expect(await store.releaseLease(claim, { availableAt: clock.now(), refundAttempt: true })).toEqual({ kind: 'lease_lost' });

    expect(mustRun(store, run.id)).toEqual(before);
  });
});

describe('refund with no attempts left', () => {
  const zeroAttempts = async () => {
    const fixture = harness();
    const run = await enqueue(fixture.store, newSession(fixture.store).id);
    const claim = mustClaim(fixture.store, 'w1');
    rawDb(fixture.dbPath).prepare('UPDATE runs SET attempts = 0 WHERE id = ?').run(run.id);
    return { ...fixture, run, claim };
  };

  it('throws from release instead of clamping', async () => {
    const { clock, store, run, claim } = await zeroAttempts();
    await expect(store.release(claim, 'QUEUED', clock.now(), { refundAttempt: true })).rejects.toThrow();
    expect(mustRun(store, run.id)).toMatchObject({ status: 'RUNNING', attempts: 0, leaseOwner: 'w1' });
  });

  it('throws from releaseLease instead of clamping', async () => {
    const { clock, store, run, claim } = await zeroAttempts();
    await expect(store.releaseLease(claim, { availableAt: clock.now(), refundAttempt: true })).rejects.toThrow();
    expect(mustRun(store, run.id)).toMatchObject({ status: 'RUNNING', attempts: 0, leaseOwner: 'w1' });
  });

  it('still releases without a refund', async () => {
    const { clock, store, run, claim } = await zeroAttempts();
    await store.releaseLease(claim, { availableAt: clock.now() });
    expect(mustRun(store, run.id)).toMatchObject({ status: 'QUEUED', attempts: 0 });
  });
});
