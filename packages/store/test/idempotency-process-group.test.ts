import { describe, expect, it } from 'vitest';
import { START_MS, harness } from './helpers.ts';

const EXPIRES_AT = START_MS + 60_000;

describe('idempotency processGroupOf', () => {
  it('a completed row keeps answering the process group it attached', () => {
    const { store } = harness();
    store.idempotency.begin('completed', { expiresAt: EXPIRES_AT, meta: {} });
    store.idempotency.attachProcess('completed', { pgid: 4242, startedAt: START_MS });
    store.idempotency.complete('completed', { exitCode: 0 });

    expect(store.idempotency.get('completed')?.s).toBe('COMPLETED');
    expect(store.idempotency.processGroupOf('completed')).toBe(4242);
  });

  it('a pending row answers its attached process group', () => {
    const { store } = harness();
    store.idempotency.begin('pending', { expiresAt: EXPIRES_AT, meta: {} });
    store.idempotency.attachProcess('pending', { pgid: 5151, startedAt: START_MS });

    expect(store.idempotency.processGroupOf('pending')).toBe(5151);
  });

  it('an unknown row answers its attached process group', () => {
    const { store } = harness();
    store.idempotency.begin('unknown', { expiresAt: EXPIRES_AT, meta: {} });
    store.idempotency.attachProcess('unknown', { pgid: 6262, startedAt: START_MS });
    store.idempotency.markUnknown('unknown');

    expect(store.idempotency.get('unknown')?.s).toBe('UNKNOWN');
    expect(store.idempotency.processGroupOf('unknown')).toBe(6262);
  });

  it('rows that never attached a process group answer undefined in every state', () => {
    const { store } = harness();
    store.idempotency.begin('pending', { expiresAt: EXPIRES_AT, meta: {} });
    store.idempotency.begin('unknown', { expiresAt: EXPIRES_AT, meta: {} });
    store.idempotency.markUnknown('unknown');
    store.idempotency.begin('completed', { expiresAt: EXPIRES_AT, meta: {} });
    store.idempotency.complete('completed', { exitCode: 0 });

    expect(store.idempotency.processGroupOf('pending')).toBeUndefined();
    expect(store.idempotency.processGroupOf('unknown')).toBeUndefined();
    expect(store.idempotency.processGroupOf('completed')).toBeUndefined();
    expect(store.idempotency.processGroupOf('missing')).toBeUndefined();
  });
});
