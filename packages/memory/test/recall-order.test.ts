import { describe, expect, it } from 'vitest';
import { recallOrder } from '@momonga/memory';
import type { MemoryRecord } from '@momonga/protocol';

const memory = (id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id,
  scope: 'user',
  origin: 'trusted',
  project: null,
  text: id,
  source: { kind: 'tool', sessionId: 's', runId: 'r', step: 1, callId: id, seq: 1 },
  createdAt: 1,
  keptAt: 1,
  kind: 'fact',
  state: 'active',
  duplicateOf: null,
  supersedes: [],
  supersededBy: [],
  retiredAt: null,
  evidence: [],
  contributedAt: null,
  observedStatus: 'unbound',
  ...overrides,
});

const order = (memories: MemoryRecord[], matched: string[] = []): string[] => recallOrder(memories, new Set(matched)).map((entry) => entry.id);

describe('recallOrder', () => {
  it('puts a match first, even a stale one over a verified note', () => {
    expect(order([memory('verified', { observedStatus: 'verified' }), memory('stale', { observedStatus: 'stale' })], ['stale'])).toEqual(['stale', 'verified']);
  });

  it('orders the tiers of the newest recorded finding verified, unbound, unverifiable, stale', () => {
    const memories = [
      memory('a', { observedStatus: 'stale' }),
      memory('b', { observedStatus: 'unverifiable' }),
      memory('c', { observedStatus: 'unbound' }),
      memory('d', { observedStatus: 'verified' }),
    ];
    expect(order(memories)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('sorts a note never observed after every tier', () => {
    expect(order([memory('never', { observedStatus: null, contributedAt: 999 }), memory('stale', { observedStatus: 'stale' })])).toEqual(['stale', 'never']);
  });

  it('reads the recorded finding, not a fresh status carried on a view', () => {
    const fresh = { ...memory('freshly-verified', { observedStatus: 'stale' }), status: 'verified' as const };
    const other = { ...memory('recorded-verified', { observedStatus: 'verified' }), status: 'stale' as const };
    expect(recallOrder([fresh, other], new Set()).map((entry) => entry.id)).toEqual(['recorded-verified', 'freshly-verified']);
  });

  it('lets status beat contribution: a stale note that contributed a moment ago stays behind', () => {
    expect(order([memory('stale', { observedStatus: 'stale', contributedAt: 999, keptAt: 999 }), memory('verified', { observedStatus: 'verified' })])).toEqual(['verified', 'stale']);
  });

  it('orders by contribution newest first, with no contribution last', () => {
    expect(order([memory('none'), memory('old', { contributedAt: 5 }), memory('new', { contributedAt: 9 })])).toEqual(['new', 'old', 'none']);
  });

  it('lets contribution beat keptAt', () => {
    expect(order([memory('kept', { keptAt: 999 }), memory('contributed', { contributedAt: 1 })])).toEqual(['contributed', 'kept']);
  });

  it('key 4 is keptAt: a tie of contribution is broken by the newest kept', () => {
    expect(order([memory('old', { keptAt: 2 }), memory('new', { keptAt: 3 })])).toEqual(['new', 'old']);
  });

  it('breaks a full tie by id', () => {
    expect(order([memory('b'), memory('c'), memory('a')])).toEqual(['a', 'b', 'c']);
  });

  it('does not change its input', () => {
    const input = [memory('b'), memory('a')];
    recallOrder(input, new Set());
    expect(input.map((entry) => entry.id)).toEqual(['b', 'a']);
  });
});
