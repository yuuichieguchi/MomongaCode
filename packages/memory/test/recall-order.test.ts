import { describe, expect, it } from 'vitest';
import { recallOrder } from '@momonga/memory';
import type { MemoryView } from '@momonga/protocol';

const memory = (id: string, overrides: Partial<MemoryView> = {}): MemoryView => ({
  id,
  scope: 'user',
  origin: 'trusted',
  project: null,
  text: id,
  source: { kind: 'tool', sessionId: 's', runId: 'r', step: 1, callId: id, seq: 1 },
  createdAt: 1,
  lastUsedAt: 1,
  kind: 'fact',
  state: 'active',
  duplicateOf: null,
  supersedes: [],
  supersededBy: [],
  retiredAt: null,
  evidence: [],
  contributedAt: null,
  status: 'unbound',
  ...overrides,
});

const order = (memories: MemoryView[], matched: string[] = []): string[] => recallOrder(memories, new Set(matched)).map((entry) => entry.id);

describe('recallOrder', () => {
  it('puts a match first, even a stale one over a verified note', () => {
    expect(order([memory('verified', { status: 'verified' }), memory('stale', { status: 'stale' })], ['stale'])).toEqual(['stale', 'verified']);
  });

  it('orders the status tiers verified, unbound, unverifiable, stale', () => {
    const memories = [memory('d', { status: 'stale' }), memory('c', { status: 'unverifiable' }), memory('b', { status: 'unbound' }), memory('a', { status: 'verified' })];
    expect(order(memories)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('lets status beat use: a stale note used a moment ago stays behind', () => {
    expect(order([memory('stale', { status: 'stale', contributedAt: 999, lastUsedAt: 999 }), memory('verified', { status: 'verified' })])).toEqual(['verified', 'stale']);
  });

  it('orders by contribution newest first, with no contribution last', () => {
    expect(order([memory('none'), memory('old', { contributedAt: 5 }), memory('new', { contributedAt: 9 })])).toEqual(['new', 'old', 'none']);
  });

  it('lets contribution beat last use', () => {
    expect(order([memory('used', { lastUsedAt: 999 }), memory('contributed', { contributedAt: 1 })])).toEqual(['contributed', 'used']);
  });

  it('breaks a tie of contribution by last use, newest first', () => {
    expect(order([memory('old', { lastUsedAt: 2 }), memory('new', { lastUsedAt: 3 })])).toEqual(['new', 'old']);
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
