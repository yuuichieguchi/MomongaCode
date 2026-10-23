import { describe, expect, it } from 'vitest';
import { START_MS, harness } from './helpers.ts';

const EXPIRES_AT = START_MS + 60_000;

describe('idempotency markUnknownIfPending', () => {
  it('markUnknownIfPending changes a PENDING record and returns true', () => {
    const { store } = harness();
    store.idempotency.begin('k1', { expiresAt: EXPIRES_AT, meta: { tool: 'Bash' } });
    store.idempotency.attachProcess('k1', { pgid: 4242, startedAt: START_MS });

    expect(store.idempotency.markUnknownIfPending('k1')).toBe(true);
    expect(store.idempotency.get('k1')).toEqual({
      s: 'UNKNOWN',
      rec: { key: 'k1', state: 'UNKNOWN', meta: { tool: 'Bash' }, pgid: 4242, startedAt: START_MS, createdAt: START_MS, expiresAt: EXPIRES_AT },
    });
  });

  it('returns false for UNKNOWN, COMPLETED and missing records and never throws', () => {
    const { store } = harness();
    store.idempotency.begin('unknown', { expiresAt: EXPIRES_AT, meta: {} });
    store.idempotency.markUnknown('unknown');
    store.idempotency.begin('completed', { expiresAt: EXPIRES_AT, meta: {} });
    store.idempotency.complete('completed', { kind: 'result', value: 1 });

    expect(store.idempotency.markUnknownIfPending('unknown')).toBe(false);
    expect(store.idempotency.markUnknownIfPending('completed')).toBe(false);
    expect(store.idempotency.markUnknownIfPending('missing')).toBe(false);
    expect(store.idempotency.get('unknown')?.s).toBe('UNKNOWN');
    expect(store.idempotency.get('completed')).toEqual({ s: 'COMPLETED', result: { kind: 'result', value: 1 } });
    expect(store.idempotency.get('missing')).toBeUndefined();
  });

  it('a lost race against complete() leaves the record COMPLETED', () => {
    const { store } = harness();
    store.idempotency.begin('k1', { expiresAt: EXPIRES_AT, meta: {} });
    const observed = store.idempotency.get('k1');
    store.idempotency.complete('k1', { done: true });

    expect(observed?.s).toBe('PENDING');
    expect(store.idempotency.markUnknownIfPending('k1')).toBe(false);
    expect(store.idempotency.get('k1')).toEqual({ s: 'COMPLETED', result: { done: true } });
  });

  it('markUnknown still throws for a non-PENDING record', () => {
    const { store } = harness();
    store.idempotency.begin('k1', { expiresAt: EXPIRES_AT, meta: {} });
    store.idempotency.complete('k1', { done: true });

    expect(() => store.idempotency.markUnknown('k1')).toThrow('cannot mark unknown idempotency key "k1": no record in state PENDING');
    expect(() => store.idempotency.markUnknown('missing')).toThrow('cannot mark unknown idempotency key "missing": no record in state PENDING');
  });
});
