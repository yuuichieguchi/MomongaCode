import { describe, expect, it } from 'vitest';
import { billedCallsOfRun, buildCostBreakdown, buildCostReport } from '@momonga/observability';
import { harness } from './helpers.ts';
import { seededRandom } from './seeded-random.ts';
import type { Random } from './seeded-random.ts';
import { TABLE, asBreakdownCall, recordCalls } from './cache-read-fixtures.ts';
import type { Billing, CallSpec } from './cache-read-fixtures.ts';

const KINDS = ['reported', 'reportedZero', 'unreported', 'inconsistent'] as const;
type Kind = (typeof KINDS)[number];
const BILLINGS: readonly Billing[] = ['metered', 'local', 'plan', 'unknown'];

type Generated = { kind: Kind; spec: CallSpec & { billing: Billing } };

const generateCall = (random: Random): Generated => {
  const kind = random.pick(KINDS);
  const billing = random.pick(BILLINGS);
  const input = random.int(10, 1000);
  if (kind === 'reported') {
    const cached = random.int(1, Math.floor(input / 2));
    return { kind, spec: { billing, input, cached, cacheWrite: random.int(0, input - cached) } };
  }
  if (kind === 'reportedZero') return { kind, spec: { billing, input, cached: 0, cacheWrite: random.int(0, input) } };
  if (kind === 'unreported') return { kind, spec: { billing, input, cacheWrite: random.int(0, Math.floor(input / 2)) } };
  const cached = random.int(Math.floor(input / 2) + 1, input);
  return { kind, spec: { billing, input, cached, cacheWrite: input - cached + random.int(1, 10) } };
};

const SEEDS = Array.from({ length: 40 }, (_unused, index) => index + 1);

const sum = (calls: readonly Generated[], pick: (call: Generated) => number): number => calls.reduce((total, call) => total + pick(call), 0);

describe('cache-read figures over random mixes of reporting and billing', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: partition, decomposition, never 0 and one cost count`, async () => {
      const random = seededRandom(seed);
      const generated = Array.from({ length: random.int(1, 8) }, () => generateCall(random));
      const h = harness();
      await recordCalls(h, 'run-a', generated.map((call) => call.spec));

      const report = buildCostReport(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: TABLE });
      const breakdown = buildCostBreakdown(billedCallsOfRun(h.store, 'run-a', TABLE).map(asBreakdownCall), {});

      const n = generated.length;
      const unreported = generated.filter((call) => call.kind === 'unreported');
      const reporting = generated.filter((call) => call.kind !== 'unreported');
      const split = generated.filter((call) => call.kind === 'reported' || call.kind === 'reportedZero');
      const meteredUnreported = unreported.filter((call) => call.spec.billing === 'metered').length;

      expect(report.total.calls).toBe(n);
      expect(report.total.cacheReadNotReportedCalls).toBe(unreported.length);
      expect(breakdown.cacheReadNotReported).toBe(unreported.length);
      expect(reporting.length + unreported.length).toBe(n);
      expect(report.total.inputTokens).toBe(sum(generated, (call) => call.spec.input));
      expect(breakdown.billed.inputTokens).toBe(sum(generated, (call) => call.spec.input));

      const runTotals = report.runs[0];
      expect(runTotals?.cacheReadNotReportedCalls).toBe(unreported.length);
      expect(Object.values(report.total.roles).reduce((total, role) => total + role.cacheReadNotReportedCalls, 0)).toBe(unreported.length);

      const reportedInput = sum(split, (call) => call.spec.input);
      const cacheRead = sum(split, (call) => call.spec.cached ?? 0);
      const cacheWrite = sum(split, (call) => call.spec.cacheWrite ?? 0);
      if (split.length === 0) {
        expect(breakdown.billed.reportedInputTokens).toBeNull();
        expect(breakdown.billed.uncachedInputTokens).toBeNull();
        expect(breakdown.billed.cacheReadTokens).toBeNull();
      } else {
        expect(breakdown.billed.reportedInputTokens).toBe(reportedInput);
        expect(breakdown.billed.cacheReadTokens).toBe(cacheRead);
        expect(breakdown.billed.cacheWriteTokens).toBe(cacheWrite);
        expect(breakdown.billed.uncachedInputTokens).toBe(reportedInput - cacheRead - cacheWrite);
      }

      if (reporting.length === 0) expect(report.total.cachedInputTokens).toBeNull();
      else expect(report.total.cachedInputTokens).toBe(sum(reporting, (call) => call.spec.cached ?? 0));

      expect(report.total.cacheReadUnpricedCalls).toBe(meteredUnreported);
      expect(breakdown.unpriced.filter((entry) => entry.reason === 'the upstream did not report the cache reads of the call')).toHaveLength(meteredUnreported);
      expect(report.total.unknownBillingCalls).toBe(generated.filter((call) => call.spec.billing === 'unknown').length);
    });
  }
});
