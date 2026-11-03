import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { buildCostReport, definePriceTable, formatCostReport, recordChatResponse, startAgentSpan, startChatSpan } from '@momonga/observability';
import { harness } from './helpers.ts';

const TABLE = definePriceTable([
  { provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 2, cachedInputPerMTok: 0.5, outputPerMTok: 8, currency: 'USD' },
  { provider: 'acme', model: 'm1', effectiveFrom: '2026-06-01', inputPerMTok: 1, outputPerMTok: 4, currency: 'USD' },
]);

const AT_MARCH = Date.parse('2026-03-10T00:00:00Z');
const AT_JULY = Date.parse('2026-07-10T00:00:00Z');

type Call = { role?: string; input: number; output: number; at: number };

const recordCalls = async (runId: string, calls: readonly Call[], h: ReturnType<typeof harness>): Promise<void> => {
  const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'momonga', agentId: 'momonga', conversationId: 's', runId });
  const parent = trace.setSpan(ROOT_CONTEXT, agent);
  for (const [index, call] of calls.entries()) {
    h.clock.set(call.at);
    const input = { providerName: 'acme', billing: 'metered' as const, requestModel: 'm1', stream: true, runId, step: index + 1, attempt: 1, ...(call.role === undefined ? {} : { role: call.role }) };
    const chat = startChatSpan(h.telemetry.tracer, input as Parameters<typeof startChatSpan>[1], parent);
    recordChatResponse(chat, { finishReasons: ['stop'], usage: { inputTokens: call.input, outputTokens: call.output } });
    chat.end(h.clock.now());
  }
  agent.end(h.clock.now());
  await h.telemetry.forceFlush();
};

type RoleTotals = { calls: number; inputTokens: number; outputTokens: number; amount: number };
type WithRoles = { roles: Record<string, RoleTotals> };

const seeded = async () => {
  const h = harness();
  await recordCalls('run-a', [
    { role: 'run', input: 1_000_000, output: 500_000, at: AT_MARCH },
    { role: 'compaction', input: 1_000_000, output: 0, at: AT_JULY },
    { role: 'reflection', input: 0, output: 250_000, at: AT_JULY },
  ], h);
  await recordCalls('run-b', [
    { role: 'classifier', input: 2_000_000, output: 0, at: AT_JULY },
    { input: 1_000_000, output: 0, at: AT_JULY },
  ], h);
  return buildCostReport(h.store, [
    { runId: 'run-a', sessionId: 'session-1' },
    { runId: 'run-b', sessionId: 'session-1' },
  ], { table: TABLE });
};

describe('the cost report per role', () => {
  it('guards a role hidden in the run total: each run splits its calls, tokens and amount by role', async () => {
    const report = await seeded();
    const runA = report.runs[0] as unknown as WithRoles;
    expect(Object.keys(runA.roles).sort()).toEqual(['compaction', 'reflection', 'run']);
    expect(runA.roles['run']).toMatchObject({ calls: 1, inputTokens: 1_000_000, outputTokens: 500_000, amount: 6 });
    expect(runA.roles['compaction']).toMatchObject({ calls: 1, inputTokens: 1_000_000, outputTokens: 0, amount: 1 });
    expect(runA.roles['reflection']).toMatchObject({ calls: 1, inputTokens: 0, outputTokens: 250_000, amount: 1 });
    expect(report.runs[0]).toMatchObject({ calls: 3, amount: 8 });
  });

  it('guards a call recorded before roles existed: a span without a role counts as a call of the run', async () => {
    const report = await seeded();
    const runB = report.runs[1] as unknown as WithRoles;
    expect(Object.keys(runB.roles).sort()).toEqual(['classifier', 'run']);
    expect(runB.roles['run']).toMatchObject({ calls: 1, inputTokens: 1_000_000, amount: 1 });
    expect(runB.roles['classifier']).toMatchObject({ calls: 1, inputTokens: 2_000_000, amount: 2 });
  });

  it('guards totals that drop a role: the session and the total sum each role across runs', async () => {
    const report = await seeded();
    for (const totals of [report.sessions[0], report.total] as unknown as WithRoles[]) {
      expect(Object.keys(totals.roles).sort()).toEqual(['classifier', 'compaction', 'reflection', 'run']);
      expect(totals.roles['run']).toMatchObject({ calls: 2, inputTokens: 2_000_000, outputTokens: 500_000, amount: 7 });
      expect(totals.roles['compaction']).toMatchObject({ calls: 1, amount: 1 });
      expect(totals.roles['reflection']).toMatchObject({ calls: 1, amount: 1 });
      expect(totals.roles['classifier']).toMatchObject({ calls: 1, amount: 2 });
    }
  });

  it('guards a report a person cannot read by role: the text prints one line per role', async () => {
    const text = formatCostReport(await seeded());
    expect(text).toContain('role run: 1 call(s), 1000000 input (0 cached) + 500000 output tokens, 6 USD at price version 2026-01-01');
    expect(text).toContain('role compaction: 1 call(s), 1000000 input (0 cached) + 0 output tokens, 1 USD at price version 2026-06-01');
    expect(text).toContain('role classifier: 1 call(s), 2000000 input (0 cached) + 0 output tokens, 2 USD at price version 2026-06-01');
  });
});
