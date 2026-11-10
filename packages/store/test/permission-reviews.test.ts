import { describe, expect, it } from 'vitest';
import type { RunCallView } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { START_MS, enqueue, harness, newSession } from './helpers.ts';

type Review = { runId: string; callId: string; label: string; reviewedAt: number };
type ReviewPage = { calls: RunCallView[]; reviews: Review[]; nextCursor: string | null };
type Reviews = {
  page(cursor: string | null, limit: number): ReviewPage;
  label(review: { runId: string; callId: string; label: string; reviewedAt: number }): 'stored' | 'unknown_call';
};
type Facts = { commit(batch: { rows: readonly []; unavailable: readonly string[]; calls: readonly RunCallView[]; throughEventId: number }): void };

const reviewsOf = (store: RuntimeStore): Reviews => (store as unknown as { permissionReviews: Reviews }).permissionReviews;
const factsOf = (store: RuntimeStore): Facts => (store as unknown as { runFacts: Facts }).runFacts;

const withCalls = () => {
  const { store } = harness();
  const session = newSession(store);
  const runs = [enqueue(store, session.id, 'a').id, enqueue(store, session.id, 'b').id].sort();
  const [first, second] = runs as [string, string];
  const calls: RunCallView[] = [
    { runId: first, callId: 'call-1', basis: 'rule', sideEffect: 'write', asked: false },
    { runId: first, callId: 'call-2', basis: 'person', sideEffect: 'exec', asked: true },
    { runId: second, callId: 'call-1', basis: 'read_only', sideEffect: 'read_only', asked: false },
  ];
  factsOf(store).commit({ rows: [], unavailable: [], calls, throughEventId: 0 });
  return { store, first, second, calls };
};

describe('permission reviews (design 5: the reviewed sample)', () => {
  it('pages the calls of terminal runs in key order with a cursor, every call exactly once', () => {
    const { store, calls } = withCalls();
    const first = reviewsOf(store).page(null, 2);
    expect(first.calls).toEqual(calls.slice(0, 2));
    expect(first.reviews).toEqual([]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const last = reviewsOf(store).page(first.nextCursor, 2);
    expect(last.calls).toEqual(calls.slice(2));
    expect(last.nextCursor).toBeNull();
  });

  it('stores a label for a call, replaces it when the call is labelled again, and returns it with the page that holds the call', () => {
    const { store, first, second } = withCalls();
    expect(reviewsOf(store).label({ runId: first, callId: 'call-2', label: 'correct', reviewedAt: START_MS + 1 })).toBe('stored');
    expect(reviewsOf(store).label({ runId: first, callId: 'call-2', label: 'unneeded_ask', reviewedAt: START_MS + 2 })).toBe('stored');
    expect(reviewsOf(store).label({ runId: second, callId: 'call-1', label: 'correct', reviewedAt: START_MS + 3 })).toBe('stored');
    expect(reviewsOf(store).page(null, 2).reviews).toEqual([{ runId: first, callId: 'call-2', label: 'unneeded_ask', reviewedAt: START_MS + 2 }]);
    expect(reviewsOf(store).page(null, 3).reviews).toHaveLength(2);
  });

  it('stores nothing for a call the record does not hold', () => {
    const { store, first } = withCalls();
    expect(reviewsOf(store).label({ runId: first, callId: 'call-missing', label: 'correct', reviewedAt: START_MS })).toBe('unknown_call');
    expect(reviewsOf(store).page(null, 3).reviews).toEqual([]);
  });

  it('refuses a cursor it did not issue', () => {
    const { store } = withCalls();
    expect(() => reviewsOf(store).page('not a cursor', 2)).toThrow(RangeError);
  });
});
