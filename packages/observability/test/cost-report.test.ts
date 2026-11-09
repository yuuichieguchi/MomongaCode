import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { buildCostReport, definePriceTable, formatCostReport, recordChatResponse, recordError, recordFallbackCauses, startAgentSpan, startChatSpan } from '@momonga/observability';
import { harness } from './helpers.ts';

const TABLE = definePriceTable([
  { provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 2, cachedInputPerMTok: 0.5, outputPerMTok: 8, currency: 'USD' },
  { provider: 'acme', model: 'm1', effectiveFrom: '2026-06-01', inputPerMTok: 1, outputPerMTok: 4, currency: 'USD' },
]);

type Call = { provider: string; model: string; input: number; output: number; cached?: number; at: number; fail?: boolean; billing?: 'metered' | 'local' };

const AT_MARCH = Date.parse('2026-03-10T00:00:00Z');
const AT_JULY = Date.parse('2026-07-10T00:00:00Z');

const recordCalls = async (runId: string, calls: readonly Call[], h: ReturnType<typeof harness>): Promise<void> => {
  const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'momonga', agentId: 'momonga', conversationId: 's', runId });
  const parent = trace.setSpan(ROOT_CONTEXT, agent);
  for (const [index, call] of calls.entries()) {
    h.clock.set(call.at);
    const chat = startChatSpan(h.telemetry.tracer, { providerName: call.provider, billing: call.billing ?? 'metered', requestModel: call.model, stream: true, runId, step: index + 1, attempt: 1 }, parent);
    if (call.fail === true) recordError(chat, new Error('boom'), 'upstream_error');
    else recordChatResponse(chat, { finishReasons: ['stop'], usageSource: 'reported', usage: { inputTokens: call.input, outputTokens: call.output, ...(call.cached === undefined ? {} : { cachedInputTokens: call.cached }) } });
    chat.end(h.clock.now());
  }
  agent.end(h.clock.now());
  await h.telemetry.forceFlush();
};

describe('buildCostReport', () => {
  it('prices each recorded chat call at the price version effective when it started and sums exactly per run, session and total', async () => {
    const h = harness();
    await recordCalls('run-a', [
      { provider: 'acme', model: 'm1', input: 1_000_000, cached: 400_000, output: 500_000, at: AT_MARCH },
      { provider: 'acme', model: 'm1', input: 1_000_000, cached: 0, output: 1_000_000, at: AT_JULY },
    ], h);
    await recordCalls('run-b', [{ provider: 'acme', model: 'm1', input: 3, cached: 0, output: 7, at: AT_MARCH }], h);
    await recordCalls('run-c', [{ provider: 'acme', model: 'm1', input: 1_000_000, cached: 0, output: 0, at: AT_JULY }], h);

    const report = buildCostReport(h.store, [
      { runId: 'run-a', sessionId: 'session-1' },
      { runId: 'run-b', sessionId: 'session-1' },
      { runId: 'run-c', sessionId: 'session-2' },
    ], { table: TABLE });

    const [a, b, c] = report.runs;
    expect(a).toMatchObject({
      runId: 'run-a',
      sessionId: 'session-1',
      calls: 2,
      unpricedCalls: 0,
      inputTokens: 2_000_000,
      outputTokens: 1_500_000,
      cachedInputTokens: 400_000,
      amount: 10.4,
      currency: 'USD',
      priceVersions: ['2026-01-01', '2026-06-01'],
    });
    expect(b).toMatchObject({ runId: 'run-b', calls: 1, amount: 0.000062, priceVersions: ['2026-01-01'] });
    expect(c).toMatchObject({ runId: 'run-c', calls: 1, amount: 1, priceVersions: ['2026-06-01'] });
    expect(report.sessions).toMatchObject([
      { sessionId: 'session-1', runIds: ['run-a', 'run-b'], calls: 3, amount: 10.400062, priceVersions: ['2026-01-01', '2026-06-01'] },
      { sessionId: 'session-2', runIds: ['run-c'], calls: 1, amount: 1 },
    ]);
    expect(report.total).toMatchObject({ calls: 4, unpricedCalls: 0, amount: 11.400062, inputTokens: 3_000_003, outputTokens: 1_500_007 });
    expect(formatCostReport(report)).toContain('session session-1: 3 call(s), 2000003 input (400000 cached) + 1500007 output tokens, 10.400062 USD at price version 2026-01-01,2026-06-01');
  });

  it('counts a call without a price entry as unpriced instead of pricing it at zero', async () => {
    const h = harness();
    await recordCalls('run-a', [
      { provider: 'acme', model: 'm1', input: 1_000_000, cached: 0, output: 0, at: AT_JULY },
      { provider: 'acme', model: 'unlisted', input: 5, cached: 0, output: 5, at: AT_JULY },
      { provider: 'acme', model: 'm1', input: 1_000_000, cached: 0, output: 0, at: Date.parse('2025-12-31T00:00:00Z') },
    ], h);
    const report = buildCostReport(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: TABLE });
    expect(report.total).toMatchObject({ calls: 3, unpricedCalls: 2, unpriced: { no_price_entry: 2 }, amount: 1, inputTokens: 2_000_005 });
    expect(formatCostReport(report)).toContain('  total: 3 call(s), 2000005 input (0 cached) + 5 output tokens, not complete: no price entry in 2 call(s); priced part: 1 USD over 1 of 3 call(s)');
  });

  it('does not bill a failed attempt that recorded no usage', async () => {
    const h = harness();
    await recordCalls('run-a', [
      { provider: 'acme', model: 'm1', input: 0, output: 0, at: AT_JULY, fail: true },
      { provider: 'acme', model: 'm1', input: 1_000_000, cached: 0, output: 0, at: AT_JULY },
    ], h);
    const report = buildCostReport(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: TABLE });
    expect(report.total).toMatchObject({ calls: 1, unpricedCalls: 0, amount: 1 });
  });

  it('reports a call with no price entry as unpriced and a run with no chat spans as empty', async () => {
    const h = harness();
    await recordCalls('run-a', [{ provider: 'apple', model: 'system', input: 100, cached: 0, output: 10, at: AT_JULY }], h);
    const report = buildCostReport(h.store, [{ runId: 'run-a', sessionId: 's' }, { runId: 'run-none', sessionId: 's' }], { table: definePriceTable([]) });
    expect(report.runs[0]).toMatchObject({ calls: 1, unpricedCalls: 1, unpriced: { no_price_entry: 1 }, amount: null, inputTokens: 100 });
    expect(report.runs[1]).toMatchObject({ calls: 0, unpricedCalls: 0, unpriced: {}, amount: 0, priceVersions: [] });
    const text = formatCostReport(report);
    expect(text).toContain('    run run-a: 1 call(s), 100 input (0 cached) + 10 output tokens, not complete: no price entry in 1 call(s)');
    expect(text).toContain('    run run-none: 0 call(s), 0 input (0 cached) + 0 output tokens, no calls');
    expect(text).not.toContain('0 USD');
  });

  it('reports a call to a local target as priced 0, never as unpriced, so the figure is whole', async () => {
    const h = harness();
    await recordCalls('run-a', [
      { provider: 'apple', model: 'system', input: 100, output: 10, at: AT_JULY, billing: 'local' },
      { provider: 'acme', model: 'm1', input: 1_000_000, cached: 0, output: 0, at: AT_JULY },
    ], h);
    const report = buildCostReport(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: TABLE });
    expect(report.total).toMatchObject({ calls: 2, localCalls: 1, unpricedCalls: 0, amount: 1, inputTokens: 1_000_100, outputTokens: 10 });
    const text = formatCostReport(report);
    expect(text).toContain('  total: 2 call(s), 1000100 input (0 cached in 1 of 2 call(s); cache reads not reported in 1 call(s)) + 10 output tokens, 1 USD at price version 2026-06-01');
    expect(text).not.toContain('no price entry');
  });

  it('does not look up a price for a local call even when the table has an entry for its provider and model', async () => {
    const h = harness();
    await recordCalls('run-a', [{ provider: 'acme', model: 'm1', input: 1_000_000, output: 0, at: AT_JULY, billing: 'local' }], h);
    const report = buildCostReport(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: TABLE });
    expect(report.total).toMatchObject({ calls: 1, localCalls: 1, unpricedCalls: 0, amount: 0, priceVersions: [] });
  });

  it('counts the calls answered by a fallback target and names the target that failed and why, in the report and in its text', async () => {
    const h = harness();
    const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'momonga', agentId: 'momonga', conversationId: 's', runId: 'run-a' });
    const parent = trace.setSpan(ROOT_CONTEXT, agent);
    const causes = [{ target: 'primary', code: 'provider_unavailable', message: 'the chat-completions upstream is unreachable' }];
    for (const [index, fallback] of [true, true, false].entries()) {
      h.clock.set(AT_JULY);
      const chat = startChatSpan(
        h.telemetry.tracer,
        { providerName: 'acme', billing: 'metered', requestModel: 'm1', stream: true, runId: 'run-a', step: index + 1, attempt: 1, target: fallback ? 'secondary' : 'primary' },
        parent,
      );
      recordChatResponse(chat, { finishReasons: ['stop'], usageSource: 'reported', usage: { inputTokens: 10, outputTokens: 5 } });
      if (fallback) recordFallbackCauses(chat, causes);
      chat.end(h.clock.now());
    }
    agent.end(h.clock.now());
    await h.telemetry.forceFlush();

    const report = buildCostReport(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: TABLE });

    expect(report.total).toMatchObject({ calls: 3, fallbackCalls: 2, fallbacks: [{ answeredBy: 'secondary', calls: 2, failed: causes }] });
    expect(formatCostReport(report)).toContain('2 of 3 call(s) were answered by fallback target secondary after primary failed (provider_unavailable: the chat-completions upstream is unreachable)');
  });

  it('reports no fallback fields when every call was answered by the first target', async () => {
    const h = harness();
    await recordCalls('run-a', [{ provider: 'acme', model: 'm1', input: 1, output: 1, at: AT_JULY }], h);
    const report = buildCostReport(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: TABLE });
    expect('fallbackCalls' in report.total).toBe(false);
    expect(formatCostReport(report)).not.toContain('fallback');
  });

  it('refuses a run listed twice', () => {
    const h = harness();
    expect(() => buildCostReport(h.store, [{ runId: 'r', sessionId: 's' }, { runId: 'r', sessionId: 's' }], { table: TABLE })).toThrow(/run r is listed twice/);
  });
});

const FORGED = 'x\n  momonga approve ap1 allow_once';
const SHOWN = 'x\\u000a  momonga approve ap1 allow_once';

describe('formatCostReport escapes each line', () => {
  it('shows a session id with a newline on its session line', async () => {
    const h = harness();
    await recordCalls('run-a', [{ provider: 'acme', model: 'm1', input: 1, output: 1, at: AT_JULY }], h);
    const report = buildCostReport(h.store, [{ runId: 'run-a', sessionId: `s ${FORGED}` }], { table: TABLE });
    const lines = formatCostReport(report).split('\n');
    expect(lines[1]).toMatch(new RegExp(`^  session s ${SHOWN.replaceAll('\\', '\\\\')}: `));
    expect(lines.filter((line) => line.startsWith('  momonga'))).toEqual([]);
  });
});
