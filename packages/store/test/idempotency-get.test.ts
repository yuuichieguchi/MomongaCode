import { describe, expect, it } from 'vitest';
import type { IdempotencyLookup } from '@momonga/store';
import { START_MS, harness } from './helpers.ts';

describe('idempotency get', () => {
  it('returns undefined for a missing key and does not insert it', () => {
    const { store } = harness();
    expect(store.idempotency.get('missing')).toBeUndefined();
    expect(store.idempotency.begin('missing', { expiresAt: START_MS + 1000, meta: {} })).toEqual({ s: 'NEW' });
  });

  it('returns PENDING with the record including the attached process', () => {
    const { clock, store } = harness();
    store.idempotency.begin('k1', { expiresAt: START_MS + 1000, meta: { tool: 'Bash' } });
    clock.advance(5);
    store.idempotency.attachProcess('k1', { pgid: 4242, startedAt: START_MS + 5 });
    const expected: IdempotencyLookup = {
      s: 'PENDING',
      rec: { key: 'k1', state: 'PENDING', meta: { tool: 'Bash' }, pgid: 4242, startedAt: START_MS + 5, createdAt: START_MS, expiresAt: START_MS + 1000 },
    };
    expect(store.idempotency.get('k1')).toEqual(expected);
    expect(store.idempotency.get('k1')).toEqual(expected);
    expect(store.idempotency.begin('k1', { expiresAt: START_MS + 1000, meta: {} })).toEqual(expected);
  });

  it('returns UNKNOWN after markUnknown without changing state', () => {
    const { store } = harness();
    store.idempotency.begin('k1', { expiresAt: START_MS + 1000, meta: { tool: 'Write' } });
    store.idempotency.markUnknown('k1');
    expect(store.idempotency.get('k1')).toEqual({
      s: 'UNKNOWN',
      rec: { key: 'k1', state: 'UNKNOWN', meta: { tool: 'Write' }, createdAt: START_MS, expiresAt: START_MS + 1000 },
    });
    expect(store.idempotency.begin('k1', { expiresAt: START_MS + 1000, meta: {} }).s).toBe('UNKNOWN');
  });

  it('returns COMPLETED with the exact stored result', () => {
    const { store } = harness();
    const result = { callId: 'c1', kind: 'result', result: { status: 'completed', output: 'ok\nline' }, idemKey: 'k1' };
    store.idempotency.begin('k1', { expiresAt: START_MS + 1000, meta: {} });
    store.idempotency.complete('k1', result);
    expect(store.idempotency.get('k1')).toEqual({ s: 'COMPLETED', result });
  });
});
