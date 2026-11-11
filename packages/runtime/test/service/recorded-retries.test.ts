import { describe, expect, it } from 'vitest';
import type { BilledCallsPageView, BilledCallView, ModelCost, RunEventPayload } from '@momonga/protocol';
import { enqueue, harness, mustClaim, newSession } from '../../../store/test/helpers.ts';
import { costReportOf, readRecordedCosts, reportCostOf } from '../../src/service/model-calls.ts';

const TWO_USD: ModelCost = { amount: 2, units: '2000000000000000', currency: 'USD', priceVersion: '2026-01-01' };

const responded = (step: number, id: string, momonga: Record<string, unknown>): RunEventPayload[] => [
  { type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: { input: 'x' } } as unknown as RunEventPayload,
  { type: 'model.responded', step, attempt: 1, response: { id, status: 'completed', output: [], usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 }, momonga } } as RunEventPayload,
];

const journalWithOneRetry = async () => {
  const { store } = harness();
  const session = newSession(store);
  const run = await enqueue(store, session.id);
  store.append(mustClaim(store, 'w1'), [{ type: 'run.started', pins: {} } as unknown as RunEventPayload, ...responded(1, 'resp_first', { cost: TWO_USD }), ...responded(2, 'resp_retried', { cost: TWO_USD, retryOf: 41 })]);
  return { store, runId: run.id, sessionId: session.id };
};

const span = (runId: string, responseId: string): BilledCallView => ({
  runId,
  responseId,
  provider: 'acme',
  model: 'm1',
  billing: 'metered',
  startMs: 1,
  usage: { inputTokens: 9, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningTokens: 0 },
});

describe('the retry of a model call travels with its charged usage in the journal (R10, DECISION-12)', () => {
  it('the recorded cost of a retried call names the recorded call it retries', async () => {
    const { store, runId } = await journalWithOneRetry();
    expect(readRecordedCosts(store, [runId], false).map((recorded) => recorded.retryOf)).toEqual([undefined, 41]);
  });

  it('the cost of a run counts its retries from that record', async () => {
    const { store, runId } = await journalWithOneRetry();
    expect(reportCostOf(store, [runId])[0]?.retries).toBe(1);
  });

  it('momonga cost prints the retries of a run and of the total', async () => {
    const { store, runId, sessionId } = await journalWithOneRetry();
    const { report, text } = await costReportOf({
      runs: [{ runId, sessionId }],
      includeRunless: false,
      fetchPage: async (): Promise<BilledCallsPageView> => ({ calls: [span(runId, 'resp_first'), span(runId, 'resp_retried')] }),
      recordedCosts: () => readRecordedCosts(store, [runId], false),
    });
    expect(report.runs[0]?.retries).toBe(1);
    expect(report.total.retries).toBe(1);
    expect(text.split('\n').find((line) => line.trim().startsWith(`run ${runId}:`))).toMatch(/^ {4}run \S+: 2 call\(s\), .*, 1 of them a retry$/);
  });
});
