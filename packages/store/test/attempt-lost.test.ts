import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { LEASE_MS, START_MS, cancel, enqueue, harness, mustClaim, newSession } from './helpers.ts';

const LOST = 'attempt.lost' as RunEventPayload['type'];

const lostRecords = (store: RuntimeStore, runId: string) => store.readRunEventsOfTypes(runId, [LOST]);

const lastSeq = (store: RuntimeStore, runId: string): number => store.readRunEvents(runId, 0, 100_000).at(-1)?.seq ?? 0;

describe('claim records a takeover as attempt.lost in its own transaction', () => {
  it('a takeover of an expired RUNNING lease appends attempt.lost with lastLiveAt = previous lease_expires_at - leaseMs, the last heartbeat', () => {
    const { clock, store } = harness();
    const run = enqueue(store, newSession(store).id);
    const first = mustClaim(store, 'w1');
    clock.advance(300);
    expect(store.heartbeat(first).kind).toBe('ok');
    clock.advance(LEASE_MS);
    const takeover = mustClaim(store, 'w2');
    expect(takeover).toMatchObject({ runId: run.id, workerId: 'w2', attempt: 2 });
    expect('takeover' in takeover).toBe(false);
    const records = lostRecords(store, run.id);
    expect(records).toEqual([expect.objectContaining({ type: 'attempt.lost', lastLiveAt: START_MS + 300, createdAt: START_MS + 300 + LEASE_MS })]);
    expect(records[0]?.seq).toBe(lastSeq(store, run.id));
  });

  it('a takeover of an expired CANCELLING lease appends attempt.lost too', () => {
    const { clock, store } = harness();
    const run = enqueue(store, newSession(store).id);
    mustClaim(store, 'w1');
    expect(cancel(store, run.id).status).toBe('CANCELLING');
    clock.advance(LEASE_MS);
    expect(mustClaim(store, 'w2').status).toBe('CANCELLING');
    expect(lostRecords(store, run.id)).toEqual([expect.objectContaining({ lastLiveAt: START_MS })]);
  });

  it('a chain of takeovers appends one attempt.lost per takeover, each with the last live instant of the holder it replaced', () => {
    const { clock, store } = harness();
    const run = enqueue(store, newSession(store).id);
    mustClaim(store, 'w1');
    clock.advance(LEASE_MS);
    const second = mustClaim(store, 'w2');
    clock.advance(200);
    expect(store.heartbeat(second).kind).toBe('ok');
    clock.advance(LEASE_MS);
    mustClaim(store, 'w3');
    expect(lostRecords(store, run.id).map((event) => (event as unknown as { lastLiveAt: number }).lastLiveAt)).toEqual([START_MS, START_MS + LEASE_MS + 200]);
  });

  it('a first claim and a claim after a graceful drain append nothing; only the later takeover appends, once', () => {
    const { clock, store } = harness();
    const run = enqueue(store, newSession(store).id);
    const first = mustClaim(store, 'w1');
    expect(lostRecords(store, run.id)).toEqual([]);
    expect(store.release(first, 'QUEUED', START_MS, { refundAttempt: true }).kind).toBe('ok');
    mustClaim(store, 'w2');
    expect(lostRecords(store, run.id)).toEqual([]);
    clock.advance(LEASE_MS);
    mustClaim(store, 'w3');
    expect(lostRecords(store, run.id)).toEqual([expect.objectContaining({ lastLiveAt: START_MS })]);
  });
});
