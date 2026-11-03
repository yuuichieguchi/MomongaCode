import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import {
  billedCallsOfRun,
  buildCostBreakdown,
  buildCostReport,
  definePriceTable,
  pageBilledCalls,
  recordChatResponse,
  startAgentSpan,
  startChatSpan,
} from '@momonga/observability';
import type { BilledCall, BreakdownCall } from '@momonga/observability';
import { harness } from './helpers.ts';

const AT = Date.parse('2026-06-01T00:00:00Z');

const TABLE = definePriceTable([
  { provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 2, cachedInputPerMTok: 0.5, cacheWritePerMTok: 2.5, outputPerMTok: 8, currency: 'USD' },
  { provider: 'home', model: 'free', effectiveFrom: '2026-01-01', inputPerMTok: 0, cachedInputPerMTok: 0, outputPerMTok: 0, currency: 'USD' },
]);

type Spec = {
  step?: number;
  role?: string;
  provider?: string;
  model?: string;
  billing?: 'metered' | 'local';
  input: number;
  cached?: number;
  cacheWrite?: number;
  at?: number;
  responseId?: string;
};

const START = { run: 0, after: 0 };

const record = async (runId: string, specs: readonly Spec[], h: ReturnType<typeof harness>): Promise<void> => {
  const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'momonga', agentId: 'momonga', conversationId: 's', runId });
  const parent = trace.setSpan(ROOT_CONTEXT, agent);
  for (const [index, spec] of specs.entries()) {
    h.clock.set(AT + (spec.at ?? index));
    const chat = startChatSpan(
      h.telemetry.tracer,
      {
        providerName: spec.provider ?? 'acme',
        billing: spec.billing ?? 'metered',
        requestModel: spec.model ?? 'm1',
        stream: true,
        runId,
        attempt: 1,
        ...(spec.step === undefined ? {} : { step: spec.step }),
      },
      parent,
    );
    if (spec.role !== undefined) chat.setAttribute('momonga.role', spec.role);
    recordChatResponse(chat, {
      ...(spec.responseId === undefined ? {} : { responseId: spec.responseId }),
      finishReasons: ['stop'],
      usage: {
        inputTokens: spec.input,
        outputTokens: 2,
        ...(spec.cached === undefined ? {} : { cachedInputTokens: spec.cached }),
        ...(spec.cacheWrite === undefined ? {} : { cacheWriteInputTokens: spec.cacheWrite }),
        reasoningTokens: 1,
      },
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

describe('billedCallsOfRun', () => {
  it('reads the step, the role, the tokens and the price of each billed chat span, and treats a span without a role as recorded before roles existed', async () => {
    const h = harness();
    await record('run-a', [{ step: 1, input: 100, cached: 10, cacheWrite: 20 }, { step: 1, role: 'classifier', input: 30 }], h);

    const calls = billedCallsOfRun(h.store, 'run-a', TABLE);

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ step: 1, provider: 'acme', model: 'm1', billing: 'metered', usage: { inputTokens: 100, cachedInputTokens: 10, cacheWriteInputTokens: 20 } });
    expect(calls[0]?.role).toBeUndefined();
    expect(calls[1]).toMatchObject({ role: 'classifier', usage: { inputTokens: 30, cachedInputTokens: 0, cacheWriteInputTokens: 0 } });
    expect(calls[0]?.price.kind).toBe('priced');
  });

  it('prices a call whose usage is inconsistent as unknown with the reason instead of failing', async () => {
    const h = harness();
    await record('run-a', [{ step: 1, input: 10, cached: 8, cacheWrite: 8 }], h);

    const [call] = billedCallsOfRun(h.store, 'run-a', TABLE);

    expect(call?.price).toEqual({ kind: 'unpriced', reason: 'cached input (8) and written input (8) together exceed the input (10)' });
  });
});

describe('pageBilledCalls', () => {
  it('pages the billed calls of more runs than one page holds, in run order, and ends with no cursor', async () => {
    const h = harness();
    await record('run-a', [{ step: 1, input: 1 }, { step: 2, input: 2 }], h);
    await record('run-b', [{ step: 1, input: 3 }], h);
    await record('run-c', [{ step: 1, input: 4 }, { step: 2, input: 5 }], h);
    const runIds = ['run-a', 'run-b', 'run-c'];

    const first = pageBilledCalls(h.store, runIds, TABLE, START, 2, false);
    const second = pageBilledCalls(h.store, runIds, TABLE, first.next ?? { run: 99, after: 0 }, 2, false);
    const third = pageBilledCalls(h.store, runIds, TABLE, second.next ?? { run: 99, after: 0 }, 2, false);

    expect(first.calls.map((call) => call.usage.inputTokens)).toEqual([1, 2]);
    expect(first.next).toEqual({ run: 1, after: 0 });
    expect(second.calls.map((call) => call.usage.inputTokens)).toEqual([3, 4]);
    expect(second.next?.run).toBe(2);
    expect(second.next?.after).toBeGreaterThan(0);
    expect(third.calls.map((call) => call.usage.inputTokens)).toEqual([5]);
    expect(third.next).toBeUndefined();
  });

  it('keys the cursor on the order the store ingested the spans, so a span with an earlier start arriving between pages is returned exactly once', async () => {
    const h = harness();
    await record('run-a', [{ step: 1, input: 1, at: 100 }, { step: 2, input: 2, at: 200 }], h);

    const first = pageBilledCalls(h.store, ['run-a'], TABLE, START, 1, false);
    await record('run-a', [{ step: 3, input: 3, at: 10 }], h);
    const second = pageBilledCalls(h.store, ['run-a'], TABLE, first.next ?? { run: 99, after: 0 }, 1, false);
    const third = pageBilledCalls(h.store, ['run-a'], TABLE, second.next ?? { run: 99, after: 0 }, 1, false);

    expect([first, second, third].flatMap((page) => page.calls.map((call) => call.usage.inputTokens))).toEqual([1, 2, 3]);
    expect(third.next).toBeUndefined();
  });

  it('carries the response id of each billed call', async () => {
    const h = harness();
    await record('run-a', [{ step: 1, input: 1, responseId: 'resp_a' }, { step: 2, input: 2 }], h);

    const page = pageBilledCalls(h.store, ['run-a'], TABLE, START, 10, false);

    expect(page.calls.map((call) => call.responseId)).toEqual(['resp_a', undefined]);
  });

  it('adds the calls that belong to no run after the listed runs only when asked', async () => {
    const h = harness();
    await record('run-a', [{ step: 1, input: 1 }], h);
    const chat = startChatSpan(h.telemetry.tracer, { providerName: 'acme', billing: 'metered', requestModel: 'm1', stream: false, attempt: 1 });
    recordChatResponse(chat, { finishReasons: ['stop'], usage: { inputTokens: 9, outputTokens: 1 } });
    chat.end(h.clock.now());
    await h.telemetry.forceFlush();

    const without = pageBilledCalls(h.store, ['run-a'], TABLE, START, 10, false);
    const withRunless = pageBilledCalls(h.store, ['run-a'], TABLE, START, 10, true);

    expect(without.calls.map((call) => call.usage.inputTokens)).toEqual([1]);
    expect(withRunless.calls.map((call) => [call.runId, call.usage.inputTokens])).toEqual([['run-a', 1], ['', 9]]);
  });

  it('refuses a page larger than the bound', () => {
    const h = harness();
    expect(() => pageBilledCalls(h.store, [], TABLE, START, 100_000, false)).toThrow(RangeError);
  });
});

describe('one pricing rule', () => {
  it('gives the same total to the cost report and to the breakdown for a priced remote call, local calls with and without a table entry, and an unpriced call', async () => {
    const h = harness();
    await record(
      'run-a',
      [
        { step: 1, input: 1000, cached: 400, cacheWrite: 100 },
        { step: 2, provider: 'home', model: 'free', billing: 'local', input: 500 },
        { step: 3, provider: 'nowhere', model: 'tiny', billing: 'local', input: 700 },
        { step: 4, provider: 'other', model: 'unlisted', input: 900 },
      ],
      h,
    );

    const report = buildCostReport(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: TABLE });
    const breakdown = buildCostBreakdown(billedCallsOfRun(h.store, 'run-a', TABLE).map(asBreakdownCall), {});

    expect(report.total.unpricedCalls).toBe(1);
    expect(breakdown.cost.unpricedCalls).toBe(1);
    expect(breakdown.cost.amount).toBeNull();
    const pricedOnly = buildCostBreakdown(billedCallsOfRun(h.store, 'run-a', TABLE).slice(0, 3).map(asBreakdownCall), {});
    expect(pricedOnly.cost.amount).toBe(report.total.amount);
    expect(report.total.amount).toBe(0.001466);
  });
});
