import { describe, expect, it } from 'vitest';
import type { IdempotencyLookup } from '@momonga/store';
import { MIGRATIONS } from '../src/schema.ts';
import { START_MS, enqueue, harness, mustClaim, newSession, rawDb } from './helpers.ts';

const EXPIRES_AT = START_MS + 86_400_000;
const KEY = 'a'.repeat(64);

const leased = () => {
  const h = harness();
  enqueue(h.store, newSession(h.store).id);
  const claim = mustClaim(h.store, 'w1');
  return { ...h, ledger: h.store.idempotency.holding(claim) };
};

const hasAuthorisedAt = (lookup: IdempotencyLookup | undefined): boolean => lookup !== undefined && lookup.s !== 'COMPLETED' && 'authorisedAt' in lookup.rec;

describe('the authorised mark of an idempotency record', () => {
  it('is migration 35, which adds a nullable authorised_at column to the idempotency table', () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 35);
    expect(migration?.sql).toMatch(/authorised_at/);
    const { dbPath } = harness();
    const columns = rawDb(dbPath).prepare("SELECT name, \"notnull\" AS \"notNull\" FROM pragma_table_info('idempotency')").all();
    expect(columns).toContainEqual({ name: 'authorised_at', notNull: 0 });
  });

  it('is absent after begin and set to the clock time by authorise, in the same write that adopts the lease token', () => {
    const { clock, store, ledger } = leased();
    ledger.begin(KEY, { expiresAt: EXPIRES_AT, meta: { tool: 'GitPush' } });
    expect(hasAuthorisedAt(store.idempotency.get(KEY))).toBe(false);
    clock.advance(7);
    expect(ledger.authorise(KEY)).toEqual({ kind: 'ok' });
    expect(store.idempotency.get(KEY)).toMatchObject({ s: 'PENDING', rec: { key: KEY, authorisedAt: START_MS + 7, leaseToken: 1 } });
  });

  it('stays set when the record later becomes UNKNOWN', () => {
    const { clock, store, ledger } = leased();
    ledger.begin(KEY, { expiresAt: EXPIRES_AT, meta: { tool: 'GitPush' } });
    clock.advance(3);
    ledger.authorise(KEY);
    store.idempotency.markUnknown(KEY);
    expect(store.idempotency.get(KEY)).toMatchObject({ s: 'UNKNOWN', rec: { authorisedAt: START_MS + 3 } });
  });

  it('is not set by attaching a process, and is kept beside the started time once authorise ran', () => {
    const { clock, store, ledger } = leased();
    ledger.begin(KEY, { expiresAt: EXPIRES_AT, meta: { tool: 'Bash' } });
    ledger.attachProcess(KEY, { pgid: 4242, startedAt: START_MS + 1 });
    expect(hasAuthorisedAt(store.idempotency.get(KEY))).toBe(false);
    clock.advance(2);
    ledger.authorise(KEY);
    expect(store.idempotency.get(KEY)).toMatchObject({ s: 'PENDING', rec: { pgid: 4242, startedAt: START_MS + 1, authorisedAt: START_MS + 2 } });
  });
});
