import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { billedCallsOfRun, buildCostBreakdown, definePriceTable, formatCostBreakdown, recordChatResponse, startAgentSpan, startChatSpan } from '@momonga/observability';
import type { BilledCall, BreakdownCall } from '@momonga/observability';
import { harness } from './helpers.ts';

const AT = Date.parse('2026-06-01T00:00:00Z');

const TABLE = definePriceTable([
  { provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 2, cachedInputPerMTok: 0.5, cacheWritePerMTok: 2.5, outputPerMTok: 8, currency: 'USD' },
]);

const breakdownOf = (h: ReturnType<typeof harness>) => buildCostBreakdown(billedCallsOfRun(h.store, 'run-a', TABLE).map(asBreakdownCall), {});

const recordMainCalls = async (cachedByCall: readonly (number | undefined)[], h: ReturnType<typeof harness>): Promise<void> => {
  const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'momonga', agentId: 'momonga', conversationId: 's', runId: 'run-a' });
  const parent = trace.setSpan(ROOT_CONTEXT, agent);
  for (const [index, cached] of cachedByCall.entries()) {
    h.clock.set(AT + index);
    const chat = startChatSpan(
      h.telemetry.tracer,
      { providerName: 'acme', billing: 'metered', requestModel: 'm1', stream: true, runId: 'run-a', attempt: 1, step: index + 1, target: 'a' },
      parent,
    );
    recordChatResponse(chat, {
      finishReasons: ['stop'],
      usage: { inputTokens: 100, outputTokens: 2, ...(cached === undefined ? {} : { cachedInputTokens: cached }) },
    });
    chat.end(h.clock.now());
  }
  agent.end(h.clock.now());
  await h.telemetry.forceFlush();
};

const asBreakdownCall = (call: BilledCall): BreakdownCall => ({
  runId: call.runId,
  ...(call.step === undefined ? {} : { step: call.step }),
  ...(call.target === undefined ? {} : { target: call.target }),
  provider: call.provider,
  model: call.model,
  billing: call.billing,
  at: new Date(call.startMs),
  price: call.price,
  prefix: { broken: false },
  usage: call.usage,
});

describe('cache-miss causes for a target that never reports cached tokens', () => {
  it('does not attribute a miss to calls whose cache reads were never reported', async () => {
    const h = harness();
    await recordMainCalls([undefined, undefined, undefined], h);

    const calls = billedCallsOfRun(h.store, 'run-a', TABLE).map(asBreakdownCall);

    expect(buildCostBreakdown(calls, {}).cacheMissCauses).toEqual({});
  });

  it('still attributes a miss to a call that reported zero cached tokens', async () => {
    const h = harness();
    await recordMainCalls([100, 0], h);

    const calls = billedCallsOfRun(h.store, 'run-a', TABLE).map(asBreakdownCall);

    expect(buildCostBreakdown(calls, {}).cacheMissCauses).toEqual({ unexplained: 1 });
  });

  it('keeps an unreported cache read as not reported instead of filling it with zero', async () => {
    const h = harness();
    await recordMainCalls([undefined], h);

    const [call] = billedCallsOfRun(h.store, 'run-a', TABLE);

    expect(call?.usage.cachedInputTokens).toBeUndefined();
  });

  it('computes the cache hit ratio over the calls that reported their cache reads, and keeps the input of every call', async () => {
    const h = harness();
    await recordMainCalls([50, undefined], h);

    const breakdown = breakdownOf(h);

    expect(breakdown.cacheHitRatio).toBe(0.5);
    expect(breakdown.billed.cacheReadTokens).toBe(50);
    expect(breakdown.billed.reportedInputTokens).toBe(100);
    expect(breakdown.billed.inputTokens).toBe(200);
  });

  it('leaves the amount unknown when a metered call did not report its cache reads, and lists the call as unpriced', async () => {
    const h = harness();
    await recordMainCalls([50, undefined], h);

    const breakdown = breakdownOf(h);

    expect(breakdown.cost).toEqual({ amount: null, currency: 'USD', unpricedCalls: 1 });
    expect(breakdown.unpriced).toEqual([{ runId: 'run-a', provider: 'acme', model: 'm1', step: 2, reason: 'the upstream did not report the cache reads of the call' }]);
  });

  it('shows how many calls were left out of the cache figures because their cache reads were not reported', async () => {
    const h = harness();
    await recordMainCalls([50, undefined], h);

    const lines = formatCostBreakdown(breakdownOf(h)).split('\n');

    expect(lines).toContain('cache reads not reported: 1 of 2 call(s) are left out of the cache split, the cache hit ratio and the cache-miss causes');
    expect(lines).toContain('cost: unknown (1 of 2 call(s) have no price)');
  });
});
