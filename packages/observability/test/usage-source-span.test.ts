import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import {
  billedCallsOfRun,
  buildCostBreakdown,
  buildCostReport,
  definePriceTable,
  formatCostBreakdown,
  formatCostReport,
  recordChatResponse,
  startAgentSpan,
  startChatSpan,
} from '@momonga/observability';
import { harness } from './helpers.ts';

const AT = Date.parse('2026-07-10T00:00:00Z');
const TABLE = definePriceTable([{ provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 1, cachedInputPerMTok: 0.5, outputPerMTok: 4, currency: 'USD' }]);

type Source = 'reported' | 'estimated' | 'unrecorded';

const recorded = async (sources: readonly Source[]) => {
  const h = harness();
  const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'momonga', agentId: 'momonga', conversationId: 's', runId: 'run-a' });
  const parent = trace.setSpan(ROOT_CONTEXT, agent);
  for (const [index, source] of sources.entries()) {
    h.clock.set(AT + index);
    const chat = startChatSpan(h.telemetry.tracer, { providerName: 'acme', billing: 'metered', requestModel: 'm1', stream: true, runId: 'run-a', step: index + 1, attempt: 1 }, parent);
    if (source !== 'unrecorded') chat.setAttribute('momonga.usage_source', source);
    recordChatResponse(chat, { finishReasons: ['stop'], usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 } });
    chat.end(h.clock.now());
  }
  agent.end(h.clock.now());
  await h.telemetry.forceFlush();
  const report = buildCostReport(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: TABLE });
  const billed = billedCallsOfRun(h.store, 'run-a', TABLE);
  const breakdown = buildCostBreakdown(
    billed.map((call) => ({ runId: call.runId, provider: call.provider, model: call.model, billing: call.billing, at: new Date(call.startMs), price: call.price, usage: call.usage })),
    {},
  );
  const totalLine = formatCostReport(report)
    .split('\n')
    .find((line) => line.startsWith('  total: '));
  return { report, billed, breakdown, totalLine, breakdownText: formatCostBreakdown(breakdown) };
};

describe('the cost report reads the usage source from the span (I-P6)', () => {
  it('gives an estimated metered span usage_not_reported on /v1/cost and the breakdown, as the journal does', async () => {
    const { report, billed, breakdown } = await recorded(['estimated']);

    expect(billed[0]?.price).toMatchObject({ kind: 'unpriced', code: 'usage_not_reported' });
    expect(report.total.unpriced).toEqual({ usage_not_reported: 1 });
    expect(report.total.amount).toBeNull();
    expect(breakdown.cost.amount).toBeNull();
  });

  it('prices a reported metered span', async () => {
    const { report, billed } = await recorded(['reported']);

    expect(billed[0]?.price).toMatchObject({ kind: 'priced' });
    expect(report.total.amount).toBe(1);
    expect((await recorded(['estimated'])).report.total.amount).toBeNull();
  });
});

describe('a span written before the usage source was recorded', () => {
  it('is "price not recorded" in the money line of the report and the breakdown, never priced and never a code', async () => {
    const { report, billed, totalLine, breakdownText } = await recorded(['reported', 'unrecorded']);
    const line = 'not complete: price not recorded in 1 call(s); priced part: 1 USD over 1 of 2 call(s)';

    expect(billed[1]?.price.kind).not.toBe('priced');
    expect(billed[1]?.price).not.toHaveProperty('code');
    expect(report.total.unpriced).toEqual({});
    expect(report.total.amount).toBe(1);
    expect(totalLine).toContain(line);
    expect(breakdownText).toContain(`cost: ${line}`);
  });

  it('leaves an all-unrecorded scope with no amount', async () => {
    const { report, totalLine } = await recorded(['unrecorded']);

    expect(report.total.amount).toBeNull();
    expect(totalLine).toContain('not complete: price not recorded in 1 call(s)');
  });
});
