import { describe, expect, it } from 'vitest';
import { buildCostBreakdown, formatCostBreakdown } from '@momonga/observability';
import type { BreakdownCall } from '@momonga/observability';
import { CACHE_MISS_CAUSES, PREFIX_EVENTS, RUN_ROLE } from '@momonga/protocol';
import type { PrefixEvent } from '@momonga/protocol';

const UNPRICED = { kind: 'unpriced', code: 'no_price_entry', reason: 'no price in the table' } as const;

type PrefixOf = { broken: false } | { broken: true; causes: PrefixEvent[] };

const KEPT: PrefixOf = { broken: false };

const brokenBy = (...causes: PrefixEvent[]): PrefixOf => ({ broken: true, causes });

const mainCall = (minute: number, target: string, cachedInputTokens: number, prefix: PrefixOf = KEPT): BreakdownCall => ({
  runId: 'run-a',
  step: minute,
  role: RUN_ROLE,
  provider: 'acme',
  model: 'm1',
  target,
  billing: 'metered',
  at: new Date(Date.UTC(2026, 5, 1, 0, minute)),
  price: UNPRICED,
  prefix,
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
  mainCall(2, 'a', 0, brokenBy('compaction')),
  mainCall(3, 'b', 0),
  sideCall(4, 'b'),
  mainCall(5, 'b', 0),
  mainCall(6, 'b', 0),
  mainCall(7, 'b', 0, brokenBy('eviction')),
  mainCall(8, 'b', 0, brokenBy()),
];

describe('the closed list of cache-miss causes', () => {
  it('is the prefix events plus target_changed, side_call and unexplained', () => {
    expect([...CACHE_MISS_CAUSES]).toEqual([...PREFIX_EVENTS, 'target_changed', 'side_call', 'unexplained']);
  });
});

describe('momonga cost --breakdown, cache breaks and cache-miss causes', () => {
  it('counts cache breaks by the prefix events recorded with each main call', () => {
    expect(buildCostBreakdown(CALLS, {}).cacheBreaks).toEqual({ compaction: 1, eviction: 1, unexplained: 1 });
  });

  it('attributes each main call that read nothing from the cache to one cause', () => {
    expect(buildCostBreakdown(CALLS, {}).cacheMissCauses).toEqual({ compaction: 1, target_changed: 1, side_call: 1, unexplained: 2, eviction: 1 });
  });

  it('prints both under the names the design gives them', () => {
    const lines = formatCostBreakdown(buildCostBreakdown(CALLS, {})).split('\n');
    const breaks = lines.find((line) => line.startsWith('cache breaks by cause:')) ?? '';
    const misses = lines.find((line) => line.startsWith('cache-miss causes:')) ?? '';
    for (const cause of ['compaction', 'eviction', 'unexplained']) expect(breaks).toContain(`${cause} 1`);
    for (const cause of ['compaction', 'eviction', 'target_changed', 'side_call']) expect(misses).toContain(`${cause} 1`);
    expect(misses).toContain('unexplained 2');
  });

  it('reports no breaks and no misses for calls that all read their prefix from the cache', () => {
    const breakdown = buildCostBreakdown([mainCall(1, 'a', 100), mainCall(2, 'a', 100)], {});
    expect(breakdown.cacheBreaks).toEqual({});
    expect(breakdown.cacheMissCauses).toEqual({});
  });
});
describe('side_call is limited to a side call on the main call target', () => {
  const causesOf = (calls: BreakdownCall[]) => buildCostBreakdown(calls, {}).cacheMissCauses;

  it('does not blame a side call that ran on another target than the main calls', () => {
    expect(causesOf([mainCall(1, 'hosted', 100), sideCall(2, 'local'), mainCall(3, 'hosted', 0)])).toEqual({ unexplained: 1 });
  });

  it('keeps a recorded prefix event over a side call on another target', () => {
    expect(causesOf([mainCall(1, 'hosted', 100), sideCall(2, 'local'), mainCall(3, 'hosted', 0, brokenBy('eviction'))])).toEqual({ eviction: 1 });
  });

  it('blames a side call on the same target as the main call', () => {
    expect(causesOf([mainCall(1, 'local', 100), sideCall(2, 'local'), mainCall(3, 'local', 0)])).toEqual({ side_call: 1 });
  });
});
