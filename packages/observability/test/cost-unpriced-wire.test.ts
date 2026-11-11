import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { definePriceTable, recordChatResponse, startAgentSpan, startChatSpan, unpricedCallsOf } from '@momonga/observability';
import type { ChatBilling } from '@momonga/observability';
import { costReportOfSpans, harness } from './helpers.ts';

const AT = Date.parse('2026-07-10T00:00:00Z');
const FULL = definePriceTable([
  { provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 1, cachedInputPerMTok: 0.5, cacheWritePerMTok: 2, outputPerMTok: 4, currency: 'USD' },
]);

const reportOf = async (calls: readonly { billing: ChatBilling; cachedInputTokens?: number }[]) => {
  const h = harness();
  const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'momonga', agentId: 'momonga', conversationId: 's', runId: 'run-a' });
  const parent = trace.setSpan(ROOT_CONTEXT, agent);
  for (const [index, call] of calls.entries()) {
    h.clock.set(AT + index);
    const chat = startChatSpan(h.telemetry.tracer, { providerName: 'acme', billing: call.billing, requestModel: 'm1', stream: true, runId: 'run-a', step: index + 1, attempt: 1 }, parent);
    recordChatResponse(chat, {
      finishReasons: ['stop'],
      usageSource: 'reported',
      usage: { inputTokens: 1_000_000, outputTokens: 0, ...(call.cachedInputTokens === undefined ? {} : { cachedInputTokens: call.cachedInputTokens }) },
    });
    chat.end(h.clock.now());
  }
  agent.end(h.clock.now());
  await h.telemetry.forceFlush();
  return costReportOfSpans(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: FULL });
};

describe('store-protocol-C17: unpricedCalls on the wire counts every call without a price', () => {
  it('counts calls that only lack the cache read count, so a null amount is never beside zero unpriced calls', async () => {
    const report = await reportOf([{ billing: 'metered' }, { billing: 'metered' }]);
    expect(report.total.amount).toBeNull();
    expect(report.total.unpricedCalls).toBe(2);
    expect(report.total.unpriced).toEqual({ cache_read_not_reported: 2 });
  });

  it('counts a plan call as unpriced beside a priced metered call, and names it by its code', async () => {
    const report = await reportOf([{ billing: 'plan' }, { billing: 'metered', cachedInputTokens: 0 }]);
    expect(report.total.unpricedCalls).toBe(1);
    expect(report.total.unpriced).toEqual({ plan: 1 });
  });

  it('sums every code', () => {
    expect(unpricedCallsOf({ plan: 1, unknown_billing: 2, cache_read_not_reported: 3, no_price_entry: 4 })).toBe(10);
  });
});
