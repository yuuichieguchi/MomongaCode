import { describe, expect, it } from 'vitest';
import { buildCostBreakdown, formatCostBreakdown } from '@momonga/observability';
import type { BreakdownCall } from '@momonga/observability';
import { CACHE_MISS_CAUSES, PREFIX_EVENTS, RUN_ROLE } from '@momonga/protocol';
import type { PrefixEvent } from '@momonga/protocol';

const UNPRICED = { kind: 'unpriced', reason: 'no price in the table' } as const;

const mainCall = (minute: number, target: string, cachedInputTokens: number, causes: PrefixEvent[] = []): BreakdownCall => ({
  runId: 'run-a',
  step: minute,
  role: RUN_ROLE,
  provider: 'acme',
  model: 'm1',
  target,
  billing: 'metered',
  at: new Date(Date.UTC(2026, 5, 1, 0, minute)),
  price: UNPRICED,
  prefix: { preservedItems: 0, toolsChanged: false, causes },
  usage: { inputTokens: 100, cachedInputTokens, cacheWriteInputTokens: 0, outputTokens: 10, reasoningTokens: 0 },
});

const sideCall = (minute: number, target: string): BreakdownCall => ({
  runId: 'run-a',
  role: 'reflection',
  provider: 'acme',
  model: 'm1',
  target,
  billing: 'metered',
  at: new Date(Date.UTC(2026, 5, 1, 0, minute)),
  price: UNPRICED,
  usage: { inputTokens: 50, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningTokens: 0 },
});

const CALLS: BreakdownCall[] = [
  mainCall(1, 'a', 100),
  mainCall(2, 'a', 0, ['compaction']),
  mainCall(3, 'b', 0),
  sideCall(4, 'b'),
  mainCall(5, 'b', 0),
  mainCall(6, 'b', 0),
  mainCall(7, 'b', 0, ['eviction']),
];

describe('the closed list of cache-miss causes', () => {
  it('is the prefix events plus target_changed, side_call and unexplained', () => {
    expect([...CACHE_MISS_CAUSES]).toEqual([...PREFIX_EVENTS, 'target_changed', 'side_call', 'unexplained']);
  });
});

describe('momonga cost --breakdown, cache breaks and cache-miss causes', () => {
  it('counts cache breaks by the prefix events recorded with each main call', () => {
    expect(buildCostBreakdown(CALLS, {}).cacheBreaks).toEqual({ compaction: 1, eviction: 1 });
  });

  it('attributes each main call that read nothing from the cache to one cause', () => {
    expect(buildCostBreakdown(CALLS, {}).cacheMissCauses).toEqual({ compaction: 1, target_changed: 1, side_call: 1, unexplained: 1, eviction: 1 });
  });

  it('prints both under the names the design gives them', () => {
    const lines = formatCostBreakdown(buildCostBreakdown(CALLS, {})).split('\n');
    const breaks = lines.find((line) => line.startsWith('cache breaks by cause:')) ?? '';
    const misses = lines.find((line) => line.startsWith('cache-miss causes:')) ?? '';
    expect(breaks).toContain('compaction 1');
    expect(breaks).toContain('eviction 1');
    for (const cause of ['compaction', 'eviction', 'target_changed', 'side_call', 'unexplained']) expect(misses).toContain(`${cause} 1`);
  });

  it('reports no breaks and no misses for calls that all read their prefix from the cache', () => {
    const breakdown = buildCostBreakdown([mainCall(1, 'a', 100), mainCall(2, 'a', 100)], {});
    expect(breakdown.cacheBreaks).toEqual({});
    expect(breakdown.cacheMissCauses).toEqual({});
  });
});