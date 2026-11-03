import { describe, expect, it } from 'vitest';
import type { BilledCallsCursorView, BilledCallsPageView, BilledCallView, TokenAnatomy } from '@momonga/protocol';
import type { ModelCallRecord } from '@momonga/store';
import { costBreakdownOf } from '../../src/service/model-calls.ts';

const ANATOMY: TokenAnatomy = {
  estimated: true,
  total: 100,
  layers: {
    system: 10,
    tools: 20,
    instructions: 0,
    skills: 0,
    governing: 0,
    memories: 0,
    summary: 0,
    workingState: 0,
    history: { user: 70, assistant: 0, toolCalls: 0, toolOutputs: 0 },
    notices: 0,
  },
  tools: { Read: 20 },
};

const idOf = (runId: string, step: number | undefined): string => `resp_${runId}_${step ?? 'none'}`;

const billed = (runId: string, step: number | undefined, input: number, extra: Partial<BilledCallView> = {}): BilledCallView => ({
  runId,
  ...(step === undefined ? {} : { step }),
  responseId: idOf(runId, step),
  provider: 'acme',
  model: 'm1',
  billing: 'metered',
  startMs: 1,
  usage: { inputTokens: input, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningTokens: 0 },
  price: { kind: 'priced', units: String(input * 1_000_000_000), priceVersion: '2026-01-01' },
  ...extra,
});

const unidentified = (call: BilledCallView): BilledCallView => {
  const { responseId: _dropped, ...rest } = call;
  return rest;
};

const requested = (step: number, attempt = 1): ModelCallRecord => ({ kind: 'requested', seq: step * 10 + attempt * 2, step, attempt, anatomy: ANATOMY });
const responded = (step: number, id: string, attempt = 1): ModelCallRecord => ({
  kind: 'responded',
  seq: step * 10 + attempt * 2 + 1,
  step,
  attempt,
  responseId: id,
  timing: { firstEventMs: 5, durationMs: 9 },
});

const pagedOver = (calls: readonly BilledCallView[], runIds: readonly string[]) => {
  const pages: number[] = [];
  const fetchPage = async (_runIds: readonly string[], cursor: BilledCallsCursorView, limit: number): Promise<BilledCallsPageView> => {
    pages.push(cursor.after);
    const ordered = runIds.flatMap((runId) => calls.filter((call) => call.runId === runId));
    const slice = ordered.slice(cursor.after, cursor.after + limit);
    return { calls: slice, ...(cursor.after + limit < ordered.length ? { next: { run: 0, after: cursor.after + limit } } : {}) };
  };
  return { fetchPage, pages };
};

describe('costBreakdownOf', () => {
  it('pages through the gateway and joins each billed call of the main role with the anatomy and timing of its response', async () => {
    const calls = [billed('r1', 1, 1), billed('r2', 1, 2), billed('r3', 1, 3)];
    const { fetchPage, pages } = pagedOver(calls, ['r1', 'r2', 'r3']);

    const { breakdown } = await costBreakdownOf({
      runIds: ['r1', 'r2', 'r3'],
      recordsOf: (runId) => [requested(1), responded(1, idOf(runId, 1))],
      fetchPage,
      pageSize: 1,
    });

    expect(pages.length).toBe(3);
    expect(breakdown.calls).toBe(3);
    expect(breakdown.layers.callsWithoutAnatomy).toBe(0);
    expect(breakdown.layers.tokens['system']).toBe(30);
    expect(breakdown.duration?.n).toBe(3);
    expect(breakdown.cost).toEqual({ amount: 0.000006, currency: 'USD', unpricedCalls: 0 });
    expect(breakdown.unjoined).toEqual([]);
  });

  it('joins on the response id: of two main spans on a step and one recorded response, only the span with that id gets the layers and the other is unjoined', async () => {
    const first = billed('r1', 1, 1, { responseId: 'resp_first' });
    const second = billed('r1', 1, 2, { responseId: 'resp_second' });
    const { fetchPage } = pagedOver([first, second], ['r1']);

    const { breakdown } = await costBreakdownOf({ runIds: ['r1'], recordsOf: () => [requested(1), responded(1, 'resp_second')], fetchPage });

    expect(breakdown.calls).toBe(2);
    expect(breakdown.layers.callsWithoutAnatomy).toBe(1);
    expect(breakdown.layers.tokens['system']).toBe(10);
    expect(breakdown.duration?.n).toBe(1);
    expect(breakdown.unjoined).toEqual([{ runId: 'r1', step: 1, reason: 'a billed model call has no recorded model response' }]);
  });

  it('bills a span with no response id with its layers not recorded and never pairs it by position', async () => {
    const { fetchPage } = pagedOver([unidentified(billed('r1', 1, 5))], ['r1']);

    const { breakdown } = await costBreakdownOf({ runIds: ['r1'], recordsOf: () => [requested(1), responded(1, idOf('r1', 1))], fetchPage });

    expect(breakdown.calls).toBe(1);
    expect(breakdown.billed.inputTokens).toBe(5);
    expect(breakdown.layers.callsWithoutAnatomy).toBe(1);
    expect(breakdown.duration).toBeNull();
    expect(breakdown.callsWithoutResponseId).toBe(1);
    expect(breakdown.unjoined).toEqual([{ runId: 'r1', step: 1, reason: 'a recorded model response has no billed model call' }]);
  });

  it('counts a run recorded in the old shape once, as calls recorded before response ids, and lists nothing under unjoined', async () => {
    const oldCalls = [unidentified(billed('r1', 1, 5)), unidentified(billed('r1', 2, 6))];
    const oldRecords: ModelCallRecord[] = [
      requested(1),
      { kind: 'responded', seq: 12, step: 1, attempt: 1, timing: { durationMs: 9 } },
      requested(2),
      { kind: 'responded', seq: 22, step: 2, attempt: 1, timing: { durationMs: 9 } },
    ];

    const { breakdown, text } = await costBreakdownOf({ runIds: ['r1'], recordsOf: () => oldRecords, fetchPage: pagedOver(oldCalls, ['r1']).fetchPage });

    expect(breakdown.calls).toBe(2);
    expect(breakdown.callsWithoutResponseId).toBe(2);
    expect(breakdown.unjoined).toEqual([]);
    expect(breakdown.layers.callsWithoutAnatomy).toBe(2);
    expect(text.match(/before response ids/g)).toHaveLength(1);
    expect(text).toContain('2 calls recorded before response ids: layers and timing not recorded');
    expect(text).not.toContain('unjoined');
  });

  it('gives each side call the timing of the charge that carries its response id, and counts one without as not recorded', async () => {
    const calls = [
      billed('r1', 1, 1),
      billed('r1', 1, 10, { role: 'compaction', responseId: 'resp_compact' }),
      billed('r1', 2, 10, { role: 'compaction', responseId: 'resp_untimed' }),
      billed('r1', 2, 4, { role: 'classifier', responseId: 'resp_judge' }),
      billed('r1', undefined, 4, { role: 'reflection', responseId: 'resp_reflect' }),
    ];
    const timings = [
      { responseId: 'resp_compact', timing: { firstEventMs: 3000, durationMs: 62_000 } },
      { responseId: 'resp_judge', timing: { durationMs: 800 } },
      { responseId: 'resp_reflect', timing: { durationMs: 5000 } },
    ];

    const { breakdown } = await costBreakdownOf({
      runIds: ['r1'],
      recordsOf: () => [requested(1), responded(1, idOf('r1', 1))],
      sideTimingsOf: () => timings,
      fetchPage: pagedOver(calls, ['r1']).fetchPage,
    });

    expect(breakdown.roles['compaction']).toMatchObject({ calls: 2, totalDurationMs: 62_000, timingNotRecorded: 1, timeToFirstToken: { n: 1 } });
    expect(breakdown.roles['classifier']).toMatchObject({ calls: 1, totalDurationMs: 800, timingNotRecorded: 0 });
    expect(breakdown.roles['reflection']).toMatchObject({ calls: 1, totalDurationMs: 5000 });
    expect(breakdown.roles['run']).toMatchObject({ calls: 1, totalDurationMs: 9 });
    expect(breakdown.duration?.n).toBe(1);
    expect(breakdown.unjoined).toEqual([]);
  });

  it('reports a recorded response that carries an id and has no billed call instead of failing', async () => {
    const lonely = await costBreakdownOf({
      runIds: ['r1'],
      recordsOf: () => [requested(1), responded(1, idOf('r1', 1)), requested(2), responded(2, 'resp_unbilled')],
      fetchPage: pagedOver([billed('r1', 1, 1)], ['r1']).fetchPage,
    });

    expect(lonely.breakdown.unjoined).toEqual([{ runId: 'r1', step: 2, reason: 'a recorded model response has no billed model call' }]);
    expect(lonely.text).toContain('unjoined: run r1, step 2');
  });

  it('joins a resumed in-flight stream once: the gateway replays the stored response under the same id with no new span', async () => {
    const { fetchPage } = pagedOver([billed('r1', 1, 1)], ['r1']);
    const resumed = [requested(1, 1), requested(1, 2), responded(1, idOf('r1', 1), 2)];

    const { breakdown } = await costBreakdownOf({ runIds: ['r1'], recordsOf: () => resumed, fetchPage });

    expect(breakdown.calls).toBe(1);
    expect(breakdown.layers.callsWithoutAnatomy).toBe(0);
    expect(breakdown.unjoined).toEqual([]);

    const twice = await costBreakdownOf({ runIds: ['r1'], recordsOf: () => [requested(1), responded(1, idOf('r1', 1)), requested(1, 2), responded(1, idOf('r1', 1), 2)], fetchPage });
    expect(twice.breakdown.calls).toBe(1);
    expect(twice.breakdown.unjoined).toEqual([]);
  });

  it('counts a call of another role, and a call recorded before roles existed as the main role', async () => {
    const calls = [billed('r1', 1, 1), billed('r1', 1, 2, { role: 'classifier', responseId: 'resp_side' }), billed('r1', 2, 3, { role: 'run' })];
    const { fetchPage } = pagedOver(calls, ['r1']);

    const { breakdown } = await costBreakdownOf({
      runIds: ['r1'],
      recordsOf: () => [requested(1), responded(1, idOf('r1', 1)), requested(2), responded(2, idOf('r1', 2))],
      fetchPage,
    });

    expect(breakdown.calls).toBe(3);
    expect(breakdown.layers.callsWithoutAnatomy).toBe(1);
    expect(breakdown.unjoined).toEqual([]);
  });

  it('refuses a gateway that repeats the cursor, never advances it, or sends a cursor with an empty page', async () => {
    const repeating = async (): Promise<BilledCallsPageView> => ({ calls: [billed('r1', 1, 1)], next: { run: 0, after: 0 } });
    await expect(costBreakdownOf({ runIds: ['r1'], recordsOf: () => [], fetchPage: repeating })).rejects.toThrow(/cursor/);

    const backwards = async (_runIds: readonly string[], cursor: BilledCallsCursorView): Promise<BilledCallsPageView> => ({
      calls: [billed('r1', 1, 1)],
      next: cursor.after === 0 ? { run: 0, after: 5 } : { run: 0, after: 2 },
    });
    await expect(costBreakdownOf({ runIds: ['r1'], recordsOf: () => [], fetchPage: backwards })).rejects.toThrow(/cursor/);

    const empty = async (): Promise<BilledCallsPageView> => ({ calls: [], next: { run: 0, after: 1 } });
    await expect(costBreakdownOf({ runIds: ['r1'], recordsOf: () => [], fetchPage: empty })).rejects.toThrow(/empty page/);

    const malformed = async (): Promise<BilledCallsPageView> => ({ calls: [billed('r1', 1, 1)], next: { run: -1, after: 1.5 } });
    await expect(costBreakdownOf({ runIds: ['r1'], recordsOf: () => [], fetchPage: malformed })).rejects.toThrow(/cursor/);
  });

  it('keeps a call from before the timing existed as billed, with its timing not recorded', async () => {
    const { fetchPage } = pagedOver([billed('r1', 1, 1)], ['r1']);

    const { breakdown, text } = await costBreakdownOf({ runIds: ['r1'], recordsOf: () => [{ kind: 'responded', seq: 1, step: 1, attempt: 1, responseId: idOf('r1', 1) }], fetchPage });

    expect(breakdown.calls).toBe(1);
    expect(breakdown.duration).toBeNull();
    expect(text).toContain('duration: not recorded');
  });
});
