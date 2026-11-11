import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { RUN_API_SCHEMAS, UNPRICED_CODES, UNPRICED_CODE_TEXT } from '@momonga/protocol';
import type { UsageSource } from '@momonga/protocol';
import {
  buildCostBreakdown,
  definePriceTable,
  priceCall,
  recordChatResponse,
  startAgentSpan,
  startChatSpan,
} from '@momonga/observability';
import type { CallBilling, ChatBilling, CostUsage, PriceCallInput, PriceTable, PricedCall } from '@momonga/observability';
import { harness, billedCallsOfRun, moneyLine, costReportOfSpans } from './helpers.ts';

const SIX = ['plan', 'unknown_billing', 'usage_not_reported', 'cache_read_not_reported', 'no_price_entry', 'unpriceable_usage'];

const AT = new Date(Date.parse('2026-07-10T00:00:00Z'));
const FULL = definePriceTable([
  { provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 1, cachedInputPerMTok: 0.5, cacheWritePerMTok: 2, outputPerMTok: 4, currency: 'USD' },
]);
const BARE = definePriceTable([{ provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 1, outputPerMTok: 4, currency: 'USD' }]);
const EMPTY = definePriceTable([]);

const price = (billing: CallBilling, usageSource: UsageSource, usage: CostUsage, table: PriceTable, at: Date = AT): PricedCall =>
  priceCall({ provider: 'acme', model: 'm1', billing, usageSource, usage, at, table } as PriceCallInput);

const classOf = (outcome: PricedCall): string => (outcome.kind === 'priced' ? 'priced' : String((outcome as { code?: unknown }).code));

const unpricedEnums = (value: unknown, found: unknown[][] = []): unknown[][] => {
  if (Array.isArray(value)) {
    for (const item of value) unpricedEnums(item, found);
    return found;
  }
  if (value === null || typeof value !== 'object') return found;
  const record = value as Record<string, unknown>;
  const properties = record['properties'] as Record<string, unknown> | undefined;
  const codes = (properties?.['unpriced'] as { properties?: { code?: { enum?: unknown[] } } } | undefined)?.properties?.code?.enum;
  if (codes !== undefined) found.push(codes);
  for (const child of Object.values(record)) unpricedEnums(child, found);
  return found;
};

describe('the six unpriced codes have one source', () => {
  it('lists usage_not_reported after unknown_billing and before cache_read_not_reported', () => {
    expect([...UNPRICED_CODES]).toEqual(SIX);
  });

  it('gives the text "usage not reported", and the table, the list and every schema enum have the same six keys', () => {
    expect(UNPRICED_CODE_TEXT).toMatchObject({ usage_not_reported: 'usage not reported' });
    expect(Object.keys(UNPRICED_CODE_TEXT).sort()).toEqual([...SIX].sort());
    const enums = unpricedEnums(RUN_API_SCHEMAS);
    expect(enums.length).toBeGreaterThan(0);
    for (const codes of enums) expect(codes).toEqual(SIX);
  });
});

describe('priceCall over billing x usage source x cache-read count x outcome (I-P2, I-P6)', () => {
  const BILLINGS: readonly CallBilling[] = ['metered', 'local', 'plan', 'unknown'];
  const SOURCES: readonly UsageSource[] = ['reported', 'estimated'];
  const COUNTS: readonly ('reported' | 'absent')[] = ['reported', 'absent'];
  const OUTCOMES: readonly { usage: CostUsage; table: PriceTable; at: Date; valid: boolean }[] = [
    { usage: { inputTokens: 100, outputTokens: 10 }, table: FULL, at: AT, valid: true },
    { usage: { inputTokens: 100, outputTokens: 10 }, table: EMPTY, at: AT, valid: true },
    { usage: { inputTokens: 100, outputTokens: 10, cacheWriteInputTokens: 40 }, table: BARE, at: AT, valid: true },
    { usage: { inputTokens: -1, outputTokens: 10 }, table: FULL, at: AT, valid: false },
    { usage: { inputTokens: 100, outputTokens: 10 }, table: FULL, at: new Date(Number.NaN), valid: false },
  ];
  const withCount = (usage: CostUsage, count: 'reported' | 'absent'): CostUsage => (count === 'reported' ? { ...usage, cachedInputTokens: 0 } : usage);

  it('reaches priced and each of the six codes, every call landing in exactly one class', () => {
    const reached = new Set<string>();
    for (const billing of BILLINGS) {
      for (const source of SOURCES) {
        for (const count of COUNTS) {
          for (const entry of OUTCOMES) {
            const outcome = price(billing, source, withCount(entry.usage, count), entry.table, entry.at);
            const kind = classOf(outcome);
            expect(['priced', ...SIX]).toContain(kind);
            reached.add(kind);
          }
        }
      }
    }
    expect([...reached].sort()).toEqual(['priced', ...SIX].sort());
  });

  it('never prices an estimated metered usage, and leaves local, plan and unknown billing as they are', () => {
    for (const count of COUNTS) {
      for (const entry of OUTCOMES.filter((candidate) => candidate.valid)) {
        const usage = withCount(entry.usage, count);
        expect(classOf(price('metered', 'estimated', usage, entry.table))).toBe('usage_not_reported');
        expect(classOf(price('local', 'estimated', usage, entry.table))).toBe('priced');
        expect(classOf(price('plan', 'estimated', usage, entry.table))).toBe('plan');
        expect(classOf(price('unknown', 'estimated', usage, entry.table))).toBe('unknown_billing');
      }
    }
  });

  it('keeps the earlier checks first: an invalid count or time is unpriceable_usage even when estimated', () => {
    expect(classOf(price('metered', 'estimated', { inputTokens: 100, outputTokens: 10 }, FULL))).toBe('usage_not_reported');
    expect(classOf(price('metered', 'estimated', { inputTokens: -1, outputTokens: 10, cachedInputTokens: 0 }, FULL))).toBe('unpriceable_usage');
    expect(classOf(price('metered', 'reported', { inputTokens: 100, outputTokens: 10 }, FULL))).toBe('cache_read_not_reported');
  });
});

describe('the money line with the sixth code', () => {
  const estimated = (): PricedCall => price('metered', 'estimated', { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 }, FULL);
  const metered = (): PricedCall => price('metered', 'reported', { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 }, FULL);

  it('counts estimated calls through their text and keeps the priced part', () => {
    expect(moneyLine([estimated(), estimated()])).toBe('not complete: usage not reported in 2 call(s)');
    expect(moneyLine([metered(), estimated()])).toBe('not complete: usage not reported in 1 call(s); priced part: 1 USD over 1 of 2 call(s)');
  });
});

describe('one rule for unpricedCalls on the report and the breakdown', () => {
  const record = async (billings: readonly ChatBilling[]) => {
    const h = harness();
    const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'momonga', agentId: 'momonga', conversationId: 's', runId: 'run-a' });
    const parent = trace.setSpan(ROOT_CONTEXT, agent);
    for (const [index, billing] of billings.entries()) {
      h.clock.set(AT.getTime() + index);
      const chat = startChatSpan(h.telemetry.tracer, { providerName: 'acme', billing, requestModel: 'm1', stream: true, runId: 'run-a', step: index + 1, attempt: 1 }, parent);
      recordChatResponse(chat, { finishReasons: ['stop'], usageSource: 'reported', usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 } });
      chat.end(h.clock.now());
    }
    agent.end(h.clock.now());
    await h.telemetry.forceFlush();
    const report = costReportOfSpans(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: FULL });
    const calls = billedCallsOfRun(h.store, 'run-a', FULL).map((call) => ({
      runId: call.runId,
      provider: call.provider,
      model: call.model,
      billing: call.billing,
      at: new Date(call.startMs),
      price: call.price,
      usage: call.usage,
    }));
    return { report, breakdown: buildCostBreakdown(calls, {}) };
  };

  it('gives one plan call and one priced metered call the same unpricedCalls, 0, on /v1/cost and the breakdown', async () => {
    const { report, breakdown } = await record(['plan', 'metered']);

    expect(report.total.unpricedCalls).toBe(0);
    expect(breakdown.cost.unpricedCalls).toBe(report.total.unpricedCalls);
  });

  it('gives the breakdown cost the count by code, as RoleCost has it', async () => {
    const { report, breakdown } = await record(['plan', 'metered']);

    expect((breakdown.cost as Record<string, unknown>)['unpriced']).toEqual({ plan: 1 });
    expect((breakdown.cost as Record<string, unknown>)['unpriced']).toEqual(report.total.unpriced);
  });
});
