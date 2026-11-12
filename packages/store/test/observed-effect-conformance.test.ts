import { describe, expect, it } from 'vitest';
import type { IdempotencyLookup } from '@momonga/store';
import { LEASE_MS, START_MS, enqueue, harness, mustClaim, newSession } from './helpers.ts';

const EXPIRES_AT = START_MS + 86_400_000;
const KEY = 'b'.repeat(64);

const leased = async () => {
  const h = harness();
  await enqueue(h.store, newSession(h.store).id);
  const claim = mustClaim(h.store, 'w1');
  return { ...h, ledger: h.store.idempotency.holding(claim) };
};

const marked = (lookup: IdempotencyLookup | undefined): boolean => lookup !== undefined && lookup.s !== 'COMPLETED' && 'authorisedAt' in lookup.rec;

const takeOver = (h: Awaited<ReturnType<typeof leased>>) => {
  h.clock.advance(LEASE_MS);
  return h.store.idempotency.holding(mustClaim(h.store, 'w2'));
};

describe('the idempotency record on the cases of ObservedEffect.tla', () => {
  it('blindRedo: a takeover after a crash between begin and the act finds the record pending, never new, so it reconciles before any act', async () => {
    const h = await leased();
    expect(h.ledger.begin(KEY, { expiresAt: EXPIRES_AT, meta: { tool: 'PullRequestCreate' } })).toEqual({ s: 'NEW' });
    h.ledger.authorise(KEY);
    const successor = takeOver(h);
    expect(successor.begin(KEY, { expiresAt: EXPIRES_AT, meta: { tool: 'PullRequestCreate' } })).toMatchObject({ s: 'PENDING', rec: { authorisedAt: START_MS } });
  });

  it('noAuthorisedMark: a record begun but never authorised carries no mark, and the reconcile of a takeover does not set one', async () => {
    const h = await leased();
    h.ledger.begin(KEY, { expiresAt: EXPIRES_AT, meta: { tool: 'PullRequestComment' } });
    const successor = takeOver(h);
    expect(successor.authorise(KEY, 'reconcile')).toEqual({ kind: 'ok' });
    expect(marked(h.store.idempotency.get(KEY))).toBe(false);
  });

  it('unknownRedo: an unknown outcome is kept; a later begin of the key finds it unknown and never starts a new act', async () => {
    const h = await leased();
    h.ledger.begin(KEY, { expiresAt: EXPIRES_AT, meta: { tool: 'PullRequestComment' } });
    h.ledger.authorise(KEY);
    h.store.idempotency.markUnknown(KEY);
    const successor = takeOver(h);
    expect(successor.begin(KEY, { expiresAt: EXPIRES_AT, meta: { tool: 'PullRequestComment' } })).toMatchObject({ s: 'UNKNOWN', rec: { authorisedAt: START_MS } });
    expect(h.store.idempotency.markUnknownIfPending(KEY)).toBe(false);
  });

  it('settles a completed record for good: a later begin finds the recorded result', async () => {
    const h = await leased();
    h.ledger.begin(KEY, { expiresAt: EXPIRES_AT, meta: { tool: 'PullRequestCreate' } });
    h.ledger.authorise(KEY);
    h.ledger.complete(KEY, { outcome: 'applied' });
    const successor = takeOver(h);
    expect(successor.begin(KEY, { expiresAt: EXPIRES_AT, meta: { tool: 'PullRequestCreate' } })).toEqual({ s: 'COMPLETED', result: { outcome: 'applied' } });
  });
});
