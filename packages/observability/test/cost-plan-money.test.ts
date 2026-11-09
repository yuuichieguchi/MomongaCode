import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { billedCallsOfRun, buildCostBreakdown, buildCostReport, definePriceTable, formatCostBreakdown, formatCostReport, recordChatResponse, startAgentSpan, startChatSpan } from '@momonga/observability';
import type { CallBilling, ChatBilling } from '@momonga/observability';
import { harness } from './helpers.ts';

const AT = Date.parse('2026-07-10T00:00:00Z');
const TABLE = definePriceTable([{ provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 1, outputPerMTok: 4, currency: 'USD' }]);

type Spec = { billing: CallBilling; model?: string };

const recorded = async (specs: readonly Spec[]) => {
  const h = harness();
  const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'momonga', agentId: 'momonga', conversationId: 's', runId: 'run-a' });
  const parent = trace.setSpan(ROOT_CONTEXT, agent);
  for (const [index, spec] of specs.entries()) {
    h.clock.set(AT + index);
    const chat = startChatSpan(
      h.telemetry.tracer,
      { providerName: 'acme', billing: spec.billing as ChatBilling, requestModel: spec.model ?? 'm1', stream: true, runId: 'run-a', step: index + 1, attempt: 1 },
      parent,
    );
    recordChatResponse(chat, { finishReasons: ['stop'], usage: { inputTokens: 300, outputTokens: 40 } });
    chat.end(h.clock.now());
  }
  agent.end(h.clock.now());
  await h.telemetry.forceFlush();
  const report = buildCostReport(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: TABLE });
  const calls = billedCallsOfRun(h.store, 'run-a', TABLE).map((call) => ({
    runId: call.runId,
    provider: call.provider,
    model: call.model,
    billing: call.billing,
    at: new Date(call.startMs),
    price: call.price,
    usage: call.usage,
  }));
  return { report, text: formatCostReport(report), breakdown: formatCostBreakdown(buildCostBreakdown(calls, {})) };
};

describe('a scope in which every call is a plan call', () => {
  it('prints no 0 USD in the report, says the money is not complete, and keeps the plan tokens line', async () => {
    const { text } = await recorded([{ billing: 'plan' }]);

    expect(text).not.toContain('0 USD');
    expect(text).toContain('not complete: plan usage, no per-token price in 1 call(s)');
    expect(text).toContain('plan usage, no per-token price: 1 call(s), 300 input + 40 output tokens');
  });

  it('prints no 0 USD in the breakdown and keeps its plan tokens line', async () => {
    const { breakdown } = await recorded([{ billing: 'plan' }]);

    expect(breakdown).not.toContain('0 USD');
    expect(breakdown).toContain('cost: not complete: plan usage, no per-token price in 1 call(s)');
    expect(breakdown).toContain('plan usage, no per-token price: 1 call(s), 300 input + 40 output tokens');
  });
});

describe('the breakdown keeps the priced part beside the unpriced calls', () => {
  it('prints the metered money as a priced part and counts the call with no entry, where it printed cost: unknown', async () => {
    const { breakdown } = await recorded([{ billing: 'metered' }, { billing: 'metered', model: 'unlisted' }]);

    expect(breakdown).toContain('cost: not complete: no price entry in 1 call(s); priced part: 0.00046 USD over 1 of 2 call(s)');
  });
});

describe('the wire amount of a scope (DC-4 (b))', () => {
  it.each<[string, Spec[]]>([
    ['all plan', [{ billing: 'plan' }]],
    ['all unknown billing', [{ billing: 'unknown' }]],
    ['all without a price entry', [{ billing: 'metered', model: 'unlisted' }]],
  ])('is null when nothing is priced: %s', async (_name, specs) => {
    const { report } = await recorded(specs);

    expect(report.total.amount).toBeNull();
    expect(report.runs[0]?.amount).toBeNull();
    expect(report.total.roles['run']?.amount).toBeNull();
  });

  it('is 0 for an all-local scope and the priced part for a mix', async () => {
    const local = await recorded([{ billing: 'local' }]);
    const mixed = await recorded([{ billing: 'metered' }, { billing: 'plan' }]);
    const planOnly = await recorded([{ billing: 'plan' }]);

    expect(planOnly.report.total.amount).toBeNull();
    expect(local.report.total.amount).toBe(0);
    expect(mixed.report.total.amount).toBe(0.00046);
  });
});
