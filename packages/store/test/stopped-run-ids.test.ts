import { describe, expect, it } from 'vitest';
import { START_MS, enqueue, harness, newSession } from './helpers.ts';

const EXPIRES_AT = START_MS + 86_400_000;

describe('stoppedRunIds', () => {
  it('lists cancelled runs that still own a pending call record, in creation order, and leaves out queued runs and runs without one', () => {
    const { store } = harness();
    const sessionId = newSession(store).id;
    const withRecord = enqueue(store, sessionId, 'first');
    const withoutRecord = enqueue(store, sessionId, 'second');
    store.idempotency.begin('a'.repeat(64), { expiresAt: EXPIRES_AT, meta: { tool: 'Ask', runId: withRecord.id } });
    expect(store.stoppedRunIds()).toEqual([]);

    expect(store.requestCancel(withRecord.id)).toMatchObject({ kind: 'ok', run: { status: 'CANCELLED' } });
    expect(store.requestCancel(withoutRecord.id)).toMatchObject({ kind: 'ok', run: { status: 'CANCELLED' } });
    const queued = enqueue(store, sessionId, 'third');
    store.idempotency.begin('b'.repeat(64), { expiresAt: EXPIRES_AT, meta: { tool: 'Ask', runId: queued.id } });

    expect(store.stoppedRunIds()).toEqual([withRecord.id]);
  });

  it('drops a run once its pending record has been resolved', () => {
    const { store } = harness();
    const run = enqueue(store, newSession(store).id, 'first');
    const key = 'c'.repeat(64);
    store.idempotency.begin(key, { expiresAt: EXPIRES_AT, meta: { tool: 'Ask', runId: run.id } });
    store.requestCancel(run.id);
    expect(store.stoppedRunIds()).toEqual([run.id]);

    store.idempotency.markUnknownIfPending(key);

    expect(store.stoppedRunIds()).toEqual([]);
  });
});
