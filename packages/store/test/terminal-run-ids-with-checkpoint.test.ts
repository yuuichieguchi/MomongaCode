import { describe, expect, it } from 'vitest';
import { LEASE_MS, START_MS, cancelToEnd, deadLetterAll, enqueue, harness, mustClaim, mustRun, newSession } from './helpers.ts';

const EXPIRES_AT = START_MS + 86_400_000;

const parkedCheckpoint = { server: 'remote', step: 1 };

describe('terminalRunIdsWithCheckpoint', () => {
  it('lists cancelled runs whose pending call record holds a checkpoint, in creation order, and leaves out queued runs and runs without one', async () => {
    const { store } = harness();
    const sessionId = newSession(store).id;
    const withCheckpoint = enqueue(store, sessionId, 'first');
    const claim = mustClaim(store, 'w1');
    const ledger = store.idempotency.holding(claim);
    ledger.begin('a'.repeat(64), { expiresAt: EXPIRES_AT, meta: { tool: 'Ask', runId: withCheckpoint.id } });
    ledger.checkpoint('a'.repeat(64), parkedCheckpoint);
    ledger.begin('d'.repeat(64), { expiresAt: EXPIRES_AT, meta: { tool: 'Ask', runId: withCheckpoint.id } });
    expect(store.terminalRunIdsWithCheckpoint()).toEqual([]);

    expect(store.requestCancel(withCheckpoint.id)).toMatchObject({ kind: 'ok', run: { status: 'CANCELLING' } });
    expect((await store.transition(claim, ['CANCELLING'], 'CANCELLED'))).toMatchObject({ kind: 'ok' });
    const withoutCheckpoint = enqueue(store, sessionId, 'second');
    store.idempotency.begin('e'.repeat(64), { expiresAt: EXPIRES_AT, meta: { tool: 'Ask', runId: withoutCheckpoint.id } });
    expect((await cancelToEnd(store, withoutCheckpoint.id)).status).toBe('CANCELLED');
    const queued = enqueue(store, sessionId, 'third');
    store.idempotency.begin('b'.repeat(64), { expiresAt: EXPIRES_AT, meta: { tool: 'Ask', runId: queued.id } });

    expect(store.terminalRunIdsWithCheckpoint()).toEqual([withCheckpoint.id]);
  });

  it('lists a run that was dead-lettered to FAILED while its call record holds a checkpoint', async () => {
    const { clock, store } = harness({ maxAttempts: 1 });
    const run = enqueue(store, newSession(store).id, 'first');
    const claim = mustClaim(store, 'w1');
    const ledger = store.idempotency.holding(claim);
    ledger.begin('f'.repeat(64), { expiresAt: EXPIRES_AT, meta: { tool: 'Ask', runId: run.id } });
    ledger.checkpoint('f'.repeat(64), parkedCheckpoint);
    clock.advance(LEASE_MS + 1);
    expect(store.claim('w2')).toBeNull();
    expect(await deadLetterAll(store)).toEqual([run.id]);
    expect(mustRun(store, run.id)).toMatchObject({ status: 'FAILED', deadLetter: true });

    expect(store.terminalRunIdsWithCheckpoint()).toEqual([run.id]);
  });

  it('does not select a terminal run again once its checkpoint was cleared, although the record stays pending', async () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id, 'first');
    const claim = mustClaim(store, 'w1');
    const key = 'c'.repeat(64);
    const ledger = store.idempotency.holding(claim);
    ledger.begin(key, { expiresAt: EXPIRES_AT, meta: { tool: 'Ask', runId: run.id } });
    ledger.checkpoint(key, parkedCheckpoint);
    store.requestCancel(run.id);
    (await store.transition(claim, ['CANCELLING'], 'CANCELLED'));
    expect(store.terminalRunIdsWithCheckpoint()).toEqual([run.id]);

    store.idempotency.clearCheckpoint(key);

    expect(store.idempotency.get(key)).toMatchObject({ s: 'PENDING' });
    expect(store.terminalRunIdsWithCheckpoint()).toEqual([]);
  });

  it('drops a run once its pending record has been resolved', async () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id, 'first');
    const claim = mustClaim(store, 'w1');
    const key = 'c'.repeat(64);
    const ledger = store.idempotency.holding(claim);
    ledger.begin(key, { expiresAt: EXPIRES_AT, meta: { tool: 'Ask', runId: run.id } });
    ledger.checkpoint(key, parkedCheckpoint);
    store.requestCancel(run.id);
    (await store.transition(claim, ['CANCELLING'], 'CANCELLED'));
    expect(store.terminalRunIdsWithCheckpoint()).toEqual([run.id]);

    store.idempotency.markUnknownIfPending(key);

    expect(store.terminalRunIdsWithCheckpoint()).toEqual([]);
  });
});
