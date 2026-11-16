import { describe, expect, it } from 'vitest';
import type { BilledCallsPageView, BilledCallView, ModelCost, RunEventPayload } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { enqueue, harness, mustClaim, newSession } from '../../../store/test/helpers.ts';
import { costBreakdownOf, costReportOf, readRecordedCosts, reportCostOf } from '../../src/service/model-calls.ts';
import { expectSchema } from './helpers.ts';

const TWO_USD: ModelCost = { amount: 2, units: '2000000000000000', currency: 'USD', priceVersion: '2026-01-01' };
const HALF_USD: ModelCost = { amount: 0.5, units: '500000000000000', currency: 'USD', priceVersion: '2026-06-01' };

const started = { type: 'run.started', pins: {} } as unknown as RunEventPayload;

const responded = (step: number, id: string, momonga?: Record<string, unknown>): RunEventPayload[] => [
  { type: 'model.requested', step, attempt: 1, digest: `d${step}`, body: { input: 'x' } } as unknown as RunEventPayload,
  {
    type: 'model.responded',
    step,
    attempt: 1,
    response: { id, status: 'completed', output: [], usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 }, ...(momonga === undefined ? {} : { momonga }) },
  } as RunEventPayload,
];

const journalOfOneRun = async (): Promise<{ store: RuntimeStore; runId: string; sessionId: string }> => {
  const { store } = harness();
  const session = newSession(store);
  const run = await enqueue(store, session.id);
  const claim = mustClaim(store, 'w1');
  store.append(claim, [
    started,
    ...responded(1, 'resp_main', { cost: TWO_USD }),
    ...responded(2, 'resp_plan', { unpriced: { code: 'plan', reason: 'plan' } }),
    ...responded(3, 'resp_before_costs'),
    { type: 'usage.charged', purpose: 'compaction', inputTokens: 5, outputTokens: 1, totalTokens: 6, responseId: 'resp_side', cost: HALF_USD },
    { type: 'usage.charged', purpose: 'reflection', inputTokens: 3, outputTokens: 1, totalTokens: 4, responseId: 'resp_reflect', cost: HALF_USD },
  ]);
  store.contextCharges.record({ purpose: 'guideline', runId: null, project: '/work/a', model: 'fm', inputTokens: 3, outputTokens: 1, totalTokens: 4, detail: { responseId: 'resp_runless', cost: TWO_USD } });
  return { store, runId: run.id, sessionId: session.id };
};

const span = (runId: string, responseId: string | undefined, extra: Partial<BilledCallView> = {}): BilledCallView => ({
  runId,
  ...(responseId === undefined ? {} : { responseId }),
  provider: 'acme',
  model: 'm1',
  billing: 'metered',
  startMs: 1,
  usage: { inputTokens: 9, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningTokens: 0 },
  ...extra,
});

const onePage = (calls: readonly BilledCallView[]) => async (): Promise<BilledCallsPageView> => ({ calls: [...calls] });

describe('readRecordedCosts', () => {
  it('reads the charged usage of every model call the journal of a run holds: the main calls, the side calls and the charges of its reflection', async () => {
    const { store, runId } = await journalOfOneRun();

    expect(readRecordedCosts(store, [runId], false)).toEqual([
      { runId, responseId: 'resp_main', step: 1, price: { kind: 'priced', cost: TWO_USD } },
      { runId, responseId: 'resp_plan', step: 2, price: { kind: 'unpriced', code: 'plan', reason: 'plan' } },
      { runId, responseId: 'resp_before_costs', step: 3, price: { kind: 'not_recorded' } },
      { runId, responseId: 'resp_side', step: 3, price: { kind: 'priced', cost: HALF_USD } },
      { runId, responseId: 'resp_reflect', step: 3, price: { kind: 'priced', cost: HALF_USD } },
    ]);
  });

  it('adds the charges that belong to no run only when they are asked for', async () => {
    const { store, runId } = await journalOfOneRun();

    expect(readRecordedCosts(store, [runId], true).at(-1)).toEqual({ runId: '', responseId: 'resp_runless', price: { kind: 'priced', cost: TWO_USD } });
    expect(readRecordedCosts(store, [], true)).toHaveLength(1);
  });
});

describe('reportCostOf', () => {
  it('sums the recorded costs of each run by price version and counts the calls with no price, asking no gateway', async () => {
    const { store, runId } = await journalOfOneRun();

    expect(reportCostOf(store, [runId])).toEqual([
      {
        runId,
        calls: 5,
        retries: 0,
        notPriced: 2,
        legacyPrecisionCalls: 0,
        priced: [
          { currency: 'USD', priceVersion: '2026-01-01', units: '2000000000000000' },
          { currency: 'USD', priceVersion: '2026-06-01', units: '1000000000000000' },
        ],
      },
    ]);
  });
});

describe('the cost views join each billed call of the trace with its recorded cost', () => {
  it('gives the breakdown the recorded price of each call and reports a call without a record as price not recorded', async () => {
    const { store, runId } = await journalOfOneRun();
    const calls = [span(runId, 'resp_main', { step: 1 }), span(runId, 'resp_side', { role: 'compaction' }), span(runId, 'resp_unknown', { step: 4 }), span(runId, undefined, { step: 5 })];

    const { breakdown, text } = await costBreakdownOf({
      runIds: [runId],
      recordsOf: (id) => store.readModelCallEvents(id),
      fetchPage: onePage(calls),
      recordedCosts: () => readRecordedCosts(store, [runId], false),
    });

    expectSchema('CostBreakdown', breakdown);
    expect(breakdown.cost).toMatchObject({ amount: 2.5, priceNotRecordedCalls: 2, priceVersions: ['2026-01-01', '2026-06-01'] });
    expect(text).toContain('price not recorded in 2 call(s)');
  });

  it('builds the cost report of runs and sessions in the runtime from the same join', async () => {
    const { store, runId, sessionId } = await journalOfOneRun();
    const calls = [span(runId, 'resp_main', { step: 1 }), span(runId, 'resp_plan', { step: 2, billing: 'plan' }), span('', 'resp_runless', { role: 'guideline' })];

    const { report, text } = await costReportOf({
      runs: [{ runId, sessionId }],
      includeRunless: true,
      fetchPage: onePage(calls),
      recordedCosts: () => readRecordedCosts(store, [runId], true),
    });

    expect(report.runs).toEqual([expect.objectContaining({ runId, sessionId, calls: 2, amount: 2, planCalls: 1, priceVersions: ['2026-01-01'] })]);
    expect(report.total).toMatchObject({ calls: 3, amount: 4, planCalls: 1 });
    expect(text).toContain(`run ${runId}`);
  });
});
