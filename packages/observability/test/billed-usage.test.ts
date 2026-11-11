import { describe, expect, it } from 'vitest';
import { billedUsageOf, summarizeRun } from '@momonga/observability';
import { harness, billedCallsOfRun } from './helpers.ts';
import { TABLE, recordCalls } from './cache-read-fixtures.ts';
import type { CallSpec } from './cache-read-fixtures.ts';

const chatSpansOf = (h: ReturnType<typeof harness>, runId: string) =>
  h.store.spansForRun(runId).filter((span) => span.attributes['gen_ai.operation.name'] === 'chat').toSorted((left, right) => left.startMs - right.startMs);

describe('billedUsageOf, the one reader of whether a call reported its cache reads', () => {
  it('leaves cachedInputTokens absent for a span that carries no cache-read attribute, and reads a reported 0 as 0', async () => {
    const h = harness();
    await recordCalls(h, 'run-a', [{ input: 100 }, { input: 200, cached: 0 }, { input: 300, cached: 120, cacheWrite: 30 }]);

    const usages = chatSpansOf(h, 'run-a').map((span) => billedUsageOf(span));

    expect(usages[0]).toEqual({ inputTokens: 100, cacheWriteInputTokens: 0, outputTokens: 2, reasoningTokens: 0 });
    expect(usages[0]).not.toHaveProperty('cachedInputTokens');
    expect(usages[1]).toEqual({ inputTokens: 200, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningTokens: 0 });
    expect(usages[2]).toEqual({ inputTokens: 300, cachedInputTokens: 120, cacheWriteInputTokens: 30, outputTokens: 2, reasoningTokens: 0 });
  });

  it('gives billedCallOf the same usage, so the billed call and the reader cannot disagree', async () => {
    const h = harness();
    await recordCalls(h, 'run-a', [{ input: 100 }, { input: 200, cached: 0 }]);

    const fromReader = chatSpansOf(h, 'run-a').map((span) => billedUsageOf(span));
    const fromCalls = billedCallsOfRun(h.store, 'run-a', TABLE).map((call) => call.usage);

    expect(fromCalls).toEqual(fromReader);
  });
});

describe('summarizeRun reads the fact through billedUsageOf', () => {
  const mixes: Record<string, readonly CallSpec[]> = {
    'all reported': [{ input: 100, cached: 40 }, { input: 50, cached: 0 }],
    'one of three unreported': [{ input: 100, cached: 40 }, { input: 50 }, { input: 70, cached: 0 }],
    'all unreported': [{ input: 100 }, { input: 50 }],
  };

  for (const [name, specs] of Object.entries(mixes)) {
    it(`counts the same unreported calls as the billed calls for ${name}`, async () => {
      const h = harness();
      await recordCalls(h, 'run-a', specs);

      const fromCalls = billedCallsOfRun(h.store, 'run-a', TABLE).filter((call) => call.usage.cachedInputTokens === undefined).length;

      expect(summarizeRun(h.store, 'run-a').cacheReadNotReportedCalls).toBe(fromCalls);
      expect(fromCalls).toBe(specs.filter((spec) => spec.cached === undefined).length);
    });
  }

  it('sums the cached input of the reporting calls only when some call reported', async () => {
    const h = harness();
    await recordCalls(h, 'run-a', mixes['one of three unreported'] ?? []);

    const summary = summarizeRun(h.store, 'run-a');

    expect(summary.cachedInputTokens).toBe(40);
    expect(summary.inputTokens).toBe(220);
    expect(summary.cacheReadNotReportedCalls).toBe(1);
  });

  it('gives null cached input, never 0, for a run whose billed calls all left their cache reads unreported', async () => {
    const h = harness();
    await recordCalls(h, 'run-a', mixes['all unreported'] ?? []);

    const summary = summarizeRun(h.store, 'run-a');

    expect(summary.cachedInputTokens).toBeNull();
    expect(summary.inputTokens).toBe(150);
    expect(summary.cacheReadNotReportedCalls).toBe(2);
  });

  it('keeps 0 cached input for a run with no billed call', () => {
    const h = harness();

    expect(summarizeRun(h.store, 'run-none').cachedInputTokens).toBe(0);
  });
});
