import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import {
  buildCostBreakdown,
  buildCostReport,
  definePriceTable,
  formatCostBreakdown,
  formatCostReport,
  pageBilledCalls,
  priceCall,
  recordChatResponse,
  startAgentSpan,
  startChatSpan,
} from '@momonga/observability';
import type { BilledCall, BreakdownCall } from '@momonga/observability';
import { harness, billedCallsOfRun } from './helpers.ts';

const AT = Date.parse('2026-07-10T00:00:00Z');

const TABLE = definePriceTable([
  { provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 1, cachedInputPerMTok: 0.5, outputPerMTok: 4, currency: 'USD' },
]);

type Spec = { billing: 'metered' | 'local' | 'plan'; input: number; output: number; cached?: number; role?: string };

const record = async (runId: string, specs: readonly Spec[], h: ReturnType<typeof harness>): Promise<void> => {
  const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'momonga', agentId: 'momonga', conversationId: 's', runId });
  const parent = trace.setSpan(ROOT_CONTEXT, agent);
  for (const [index, spec] of specs.entries()) {
    h.clock.set(AT + index);
    const chat = startChatSpan(
      h.telemetry.tracer,
      { providerName: 'acme', billing: spec.billing, requestModel: 'm1', stream: true, runId, step: index + 1, attempt: 1 },
      parent,
    );
    if (spec.role !== undefined) chat.setAttribute('momonga.role', spec.role);
    recordChatResponse(chat, {
      finishReasons: ['stop'],
      usageSource: 'reported',
      usage: { inputTokens: spec.input, outputTokens: spec.output, ...(spec.cached === undefined ? {} : { cachedInputTokens: spec.cached }) },
    });
    chat.end(h.clock.now());
  }
  agent.end(h.clock.now());
  await h.telemetry.forceFlush();
};

const asBreakdownCall = (call: BilledCall): BreakdownCall => ({
  runId: call.runId,
  provider: call.provider,
  model: call.model,
  billing: call.billing,
  at: new Date(call.startMs),
  price: call.price,
  usage: call.usage,
});

describe('priceCall on a plan target', () => {
  it('is unpriced with the reason plan, not zero, even when the table has an entry for the model', () => {
    const priced = priceCall({
      usageSource: 'reported',
      provider: 'acme',
      model: 'm1',
      billing: 'plan',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      at: new Date(AT),
      table: TABLE,
    });
    expect(priced).toEqual({ kind: 'unpriced', code: 'plan', reason: 'plan' });
  });

  it('is unpriced with the reason plan on an empty table', () => {
    const priced = priceCall({ usageSource: 'reported', provider: 'x', model: 'y', billing: 'plan', usage: { inputTokens: 1, outputTokens: 1 }, at: new Date(AT), table: definePriceTable([]) });
    expect(priced).toEqual({ kind: 'unpriced', code: 'plan', reason: 'plan' });
  });
});

describe('billed calls of a plan target', () => {
  it('reads the billing plan from the span and prices it as unpriced with the reason plan', async () => {
    const h = harness();
    await record('run-a', [{ billing: 'plan', input: 100, output: 10 }], h);

    const [call] = billedCallsOfRun(h.store, 'run-a', TABLE);

    expect(call?.billing).toBe('plan');
    expect(call?.price).toEqual({ kind: 'unpriced', code: 'plan', reason: 'plan' });
  });

  it('pages a plan call with the billing plan and the reason plan', async () => {
    const h = harness();
    await record('run-a', [{ billing: 'plan', input: 100, output: 10 }], h);

    const page = pageBilledCalls(h.store, ['run-a'], TABLE, { run: 0, after: 0 }, 10, false);

    expect(page.calls[0]).toMatchObject({ billing: 'plan', price: { kind: 'unpriced', code: 'plan', reason: 'plan' } });
  });
});

describe('the cost report on plan calls', () => {
  it('counts plan calls and tokens on their own, adds no money, and counts them as neither unpriced, unknown nor local', async () => {
    const h = harness();
    await record(
      'run-a',
      [
        { billing: 'metered', input: 1_000_000, output: 0, cached: 0 },
        { billing: 'plan', input: 300, output: 40, cached: 100 },
        { billing: 'plan', input: 50, output: 5, role: 'classifier' },
      ],
      h,
    );

    const report = buildCostReport(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: TABLE });

    expect(report.total).toMatchObject({
      calls: 3,
      planCalls: 2,
      planInputTokens: 350,
      planOutputTokens: 45,
      unpricedCalls: 0,
      unknownBillingCalls: 0,
      localCalls: 0,
      amount: 1,
      inputTokens: 1_000_350,
      outputTokens: 45,
    });
    expect(report.total.roles['classifier']).toMatchObject({ planCalls: 1, planInputTokens: 50, planOutputTokens: 5 });
    expect(report.total.roles['run']).toMatchObject({ planCalls: 1, planInputTokens: 300, planOutputTokens: 40 });
  });

  it('prints a line "plan usage, no per-token price" with the plan calls and tokens, and never calls a plan call unpriced or unknown', async () => {
    const h = harness();
    await record('run-a', [{ billing: 'plan', input: 300, output: 40 }], h);

    const text = formatCostReport(buildCostReport(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: TABLE }));

    expect(text).toContain('plan usage, no per-token price: 1 call(s), 300 input + 40 output tokens');
    expect(text).not.toContain('no price entry');
    expect(text).not.toContain('unknown billing');
  });

  it('prints no plan line when no call used a plan', async () => {
    const h = harness();
    await record('run-a', [{ billing: 'metered', input: 10, output: 1 }], h);

    const text = formatCostReport(buildCostReport(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: TABLE }));

    expect(text).not.toContain('plan usage');
  });
});

describe('the cost breakdown on plan calls', () => {
  it('keeps plan calls out of the unpriced list, counts them by code in the money line beside the priced part, and reports the plan calls and tokens', async () => {
    const h = harness();
    await record(
      'run-a',
      [
        { billing: 'metered', input: 1_000_000, output: 0, cached: 0 },
        { billing: 'plan', input: 300, output: 40 },
      ],
      h,
    );
    const calls = billedCallsOfRun(h.store, 'run-a', TABLE).map(asBreakdownCall);

    const breakdown = buildCostBreakdown(calls, {});

    expect(breakdown.unpriced).toEqual([]);
    expect(breakdown.cost).toEqual({ amount: 1, currency: 'USD', unpricedCalls: 0, unpriced: { plan: 1 }, priceNotRecordedCalls: 0, priceVersions: ['2026-01-01'] });
    expect(breakdown.plan).toEqual({ calls: 1, inputTokens: 300, outputTokens: 40 });
    const text = formatCostBreakdown(breakdown);
    expect(text).toContain('plan usage, no per-token price: 1 call(s), 300 input + 40 output tokens');
    expect(text).toContain('cost: not complete: plan usage, no per-token price in 1 call(s); priced part: 1 USD over 1 of 2 call(s)');
    expect(text).not.toContain('cost: 1 USD');
    expect(text).not.toContain('unpriced:');
  });
});
