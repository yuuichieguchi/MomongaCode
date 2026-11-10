import { describe, expect, it } from 'vitest';
import { createFakeClock } from '@momonga/testkit';
import { LEASE_MS, START_MS, cancelToEnd, deadLetterAll, enqueue, harness, makeStoreDir, mustClaim, mustRun, newSession, openStoreAt, rawDb } from '../helpers.ts';
import path from 'node:path';

const leaseGeneration = (dbPath: string, runId: string): unknown => rawDb(dbPath).prepare('SELECT lease_generation FROM runs WHERE id = ?').get(runId)?.['lease_generation'];

describe('runs.lease_generation (17.3, 20.37)', () => {
  it('is written by claim with the generation the store was opened for', () => {
    const { dbPath, store } = harness({ generation: 1 });
    const run = enqueue(store, newSession(store).id);
    expect(leaseGeneration(dbPath, run.id)).toBeNull();
    mustClaim(store, 'w1');
    expect(leaseGeneration(dbPath, run.id)).toBe(1);
  });

  it('is null for a claim by a store opened without a generation', () => {
    const { dbPath, store } = harness();
    const run = enqueue(store, newSession(store).id);
    mustClaim(store, 'w1');
    expect(leaseGeneration(dbPath, run.id)).toBeNull();
  });

  it('is cleared by release', async () => {
    const { dbPath, store } = harness({ generation: 1 });
    const run = enqueue(store, newSession(store).id);
    await store.release(mustClaim(store, 'w1'), 'QUEUED', START_MS);
    expect(leaseGeneration(dbPath, run.id)).toBeNull();
    expect(mustRun(store, run.id).leaseOwner).toBeNull();
  });

  it('is cleared by releaseLease, and the attempt is refunded as before', async () => {
    const { dbPath, store } = harness({ generation: 1 });
    const run = enqueue(store, newSession(store).id);
    const result = await store.releaseLease(mustClaim(store, 'w1'), { availableAt: START_MS, refundAttempt: true });
    expect(result.kind).toBe('ok');
    expect(leaseGeneration(dbPath, run.id)).toBeNull();
    expect(mustRun(store, run.id)).toMatchObject({ status: 'QUEUED', leaseOwner: null, attempts: 0 });
  });

  it('is cleared by the terminal transition', async () => {
    const { dbPath, store } = harness({ generation: 1 });
    const run = enqueue(store, newSession(store).id);
    const result = await store.transition(mustClaim(store, 'w1'), ['RUNNING'], 'COMPLETED');
    expect(result.kind).toBe('ok');
    expect(leaseGeneration(dbPath, run.id)).toBeNull();
  });

  it('is cleared by the dead letter', async () => {
    const { clock, dbPath, store } = harness({ generation: 1, maxAttempts: 1 });
    const run = enqueue(store, newSession(store).id);
    mustClaim(store, 'w1');
    clock.advance(LEASE_MS + 1);
    expect(await deadLetterAll(store)).toEqual([run.id]);
    expect(leaseGeneration(dbPath, run.id)).toBeNull();
  });

  it('is cleared by finishCancelled', async () => {
    const { clock, dbPath, store } = harness({ generation: 1 });
    const run = enqueue(store, newSession(store).id);
    mustClaim(store, 'w1');
    clock.advance(LEASE_MS + 1);
    rawDb(dbPath).prepare("UPDATE runs SET status = 'QUEUED', lease_owner = NULL, lease_expires_at = NULL WHERE id = ?").run(run.id);
    rawDb(dbPath).prepare('UPDATE runs SET lease_generation = 1 WHERE id = ?').run(run.id);
    await cancelToEnd(store, run.id);
    expect(leaseGeneration(dbPath, run.id)).toBeNull();
  });

  it('takes the generation of the store that takes an expired lease over, and the lease token still decides writes', async () => {
    const dbPath = path.join(makeStoreDir(), 'runtime.db');
    const clock = createFakeClock(START_MS);
    const first = openStoreAt(dbPath, clock, { generation: 1 });
    const second = openStoreAt(dbPath, clock, { generation: 2 });
    const run = enqueue(first, newSession(first).id);
    const stale = mustClaim(first, 'w1');
    clock.advance(LEASE_MS + 1);
    const taken = mustClaim(second, 'w2');
    expect(leaseGeneration(dbPath, run.id)).toBe(2);
    expect(taken.leaseToken).toBe(stale.leaseToken + 1);
    expect(first.append(stale, [{ type: 'notice', level: 'info', message: 'late' }])).toEqual({ kind: 'lease_lost' });
    expect(second.append(taken, [{ type: 'notice', level: 'info', message: 'held' }]).kind).toBe('ok');
  });
});
