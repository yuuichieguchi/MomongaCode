import { describe, expect, it } from 'vitest';
import { buildCostReport, definePriceTable, formatCostReport, recordChatResponse, startChatSpan } from '@momonga/observability';
import { harness } from './helpers.ts';

const TABLE = definePriceTable([{ provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 2, outputPerMTok: 8, currency: 'USD' }]);
const AT = Date.parse('2026-03-10T00:00:00Z');

type Call = { runId?: string; role: string; input: number; output: number };

const record = async (calls: readonly Call[]) => {
  const h = harness();
  h.clock.set(AT);
  for (const [index, call] of calls.entries()) {
    const chat = startChatSpan(h.telemetry.tracer, {
      providerName: 'acme',
      billing: 'metered',
      requestModel: 'm1',
      stream: true,
      attempt: 1,
      step: index + 1,
      role: call.role,
      ...(call.runId === undefined ? {} : { runId: call.runId }),
    });
    recordChatResponse(chat, { finishReasons: ['stop'], usage: { inputTokens: call.input, outputTokens: call.output } });
    chat.end(h.clock.now());
  }
  await h.telemetry.forceFlush();
  return h;
};

const CALLS: readonly Call[] = [
  { runId: 'run-a', role: 'run', input: 1_000_000, output: 0 },
  { role: 'analysis', input: 1_000_000, output: 500_000 },
  { role: 'analysis', input: 1_000_000, output: 0 },
];

const RUNS = [{ runId: 'run-a', sessionId: 'session-1' }];

describe('the cost report of calls that belong to no run', () => {
  it('guards an analysis that never shows: the total counts calls without a run id under their role when asked to', async () => {
    const h = await record(CALLS);
    const report = buildCostReport(h.store, RUNS, { table: TABLE, includeRunless: true });
    expect(Object.keys(report.total.roles).sort()).toEqual(['analysis', 'run']);
    expect(report.total.roles['analysis']).toMatchObject({ calls: 2, inputTokens: 2_000_000, outputTokens: 500_000, amount: 8 });
    expect(report.total).toMatchObject({ calls: 3, inputTokens: 3_000_000, amount: 10 });
  });

  it('guards a run that is charged for what it did not call: runs and sessions never include calls without a run id', async () => {
    const h = await record(CALLS);
    const report = buildCostReport(h.store, RUNS, { table: TABLE, includeRunless: true });
    expect(report.runs[0]).toMatchObject({ calls: 1, amount: 2 });
    expect(Object.keys(report.runs[0]?.roles ?? {})).toEqual(['run']);
    expect(Object.keys(report.sessions[0]?.roles ?? {})).toEqual(['run']);
  });

  it('guards a scoped report that grows: without the option the total counts only the listed runs', async () => {
    const h = await record(CALLS);
    const report = buildCostReport(h.store, RUNS, { table: TABLE });
    expect(Object.keys(report.total.roles)).toEqual(['run']);
    expect(report.total).toMatchObject({ calls: 1, amount: 2 });
  });

  it('guards a report a person cannot read by role: the text prints the analysis line under the total', async () => {
    const h = await record(CALLS);
    const text = formatCostReport(buildCostReport(h.store, RUNS, { table: TABLE, includeRunless: true }));
    expect(text).toContain('role analysis: 2 call(s), 2000000 input (0 cached) + 500000 output tokens, 8 USD at price version 2026-01-01');
  });
});
