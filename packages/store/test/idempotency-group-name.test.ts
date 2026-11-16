import { describe, expect, it } from 'vitest';
import { START_MS, harness } from './helpers.ts';

const EXPIRES_AT = START_MS + 60_000;

describe('idempotency group name', () => {
  it('a pending row answers the group name it attached with its process group', () => {
    const { store } = harness();
    store.idempotency.begin('named', { expiresAt: EXPIRES_AT, meta: {} });
    store.idempotency.attachProcess('named', { pgid: 4242, startedAt: START_MS, groupName: 'momonga-4242' });

    const lookup = store.idempotency.get('named');
    expect(lookup?.s === 'PENDING' ? lookup.rec.groupName : undefined).toBe('momonga-4242');
  });

  it('a row attached without a group name answers none', () => {
    const { store } = harness();
    store.idempotency.begin('unnamed', { expiresAt: EXPIRES_AT, meta: {} });
    store.idempotency.attachProcess('unnamed', { pgid: 5151, startedAt: START_MS });

    const lookup = store.idempotency.get('unnamed');
    expect(lookup?.s === 'PENDING' ? lookup.rec.groupName : 'absent').toBeUndefined();
  });
});
