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

const billed = (runId: string, step: number | undefined, input: number, extra: Partial<BilledCallView> = {}): BilledCallView => ({
  runId,
  ...(step === undefined ? {} : { step }),
  provider: 'acme',
  model: 'm1',
  billing: 'metered',
  startMs: 1,
  usage: { inputTokens: input, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningTokens: 0 },
  price: { kind: 'priced', units: String(input * 1_000_000_000), priceVersion: '2026-01-01' },
  ...extra,
});

const requested = (step: number): ModelCallRecord => ({ kind: 'requested', seq: step * 2, step, attempt: 1, anatomy: ANATOMY });
const responded = (step: number): ModelCallRecord => ({ kind: 'responded', seq: step * 2 + 1, step, attempt: 1, timing: { firstEventMs: 5, durationMs: 9 } });

const pagedOver = (calls: readonly BilledCallView[], runIds: readonly string[]) => {
  const pages: number[] = [];
  const fetchPage = async (_runIds: readonly string[], cursor: BilledCallsCursorView, limit: number): Promise<BilledCallsPageView> => {
    pages.push(cursor.offset);
    const ordered = runIds.flatMap((runId) => calls.filter((call) => call.runId === runId));
    const slice = ordered.slice(cursor.offset, cursor.offset + limit);
    return { calls: slice, ...(cursor.offset + limit < ordered.length ? { next: { run: 0, offset: cursor.offset + limit } } : {}) };
  };
  return { fetchPage, pages };
};

describe('costBreakdownOf', () => {
  it('pages through the gateway and joins each billed call of the main role with the anatomy and timing of its response', async () => {
    const calls = [billed('r1', 1, 1), billed('r2', 1, 2), billed('r3', 1, 3)];
    const { fetchPage, pages } = pagedOver(calls, ['r1', 'r2', 'r3']);

    const { breakdown } = await costBreakdownOf({
      runIds: ['r1', 'r2', 'r3'],
      recordsOf: () => [requested(1), responded(1)],
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

  it('reports a billed call without a response and a response without a billed call instead of failing', async () => {
    const calls = [billed('r1', 1, 1), billed('r1', 1, 2), billed('r1', undefined, 4)];
    const { fetchPage } = pagedOver(calls, ['r1']);
    const answered = await costBreakdownOf({ runIds: ['r1'], recordsOf: () => [requested(1), responded(1)], fetchPage });

    expect(answered.breakdown.calls).toBe(3);
    expect(answered.breakdown.unjoined).toEqual([
      { runId: 'r1', step: 1, reason: 'a billed model call has no recorded model response' },
      { runId: 'r1', reason: 'a billed model call has no recorded model response' },
    ]);

    const lonely = await costBreakdownOf({ runIds: ['r1'], recordsOf: () => [requested(1), responded(1), requested(2), responded(2)], fetchPage: pagedOver([billed('r1', 1, 1)], ['r1']).fetchPage });
    expect(lonely.breakdown.unjoined).toEqual([{ runId: 'r1', step: 2, reason: 'a recorded model response has no billed model call' }]);
    expect(lonely.text).toContain('unjoined: run r1, step 2');
  });

  it('counts a call of another role, and a call recorded before roles existed as the main role', async () => {
    const calls = [billed('r1', 1, 1), billed('r1', 1, 2, { role: 'classifier' }), billed('r1', 2, 3, { role: 'run' })];
    const { fetchPage } = pagedOver(calls, ['r1']);

    const { breakdown } = await costBreakdownOf({ runIds: ['r1'], recordsOf: () => [requested(1), responded(1), requested(2), responded(2)], fetchPage });

    expect(breakdown.calls).toBe(3);
    expect(breakdown.layers.callsWithoutAnatomy).toBe(1);
    expect(breakdown.unjoined).toEqual([]);
  });

  it('keeps a call from before the timing existed as billed, with its timing not recorded', async () => {
    const { fetchPage } = pagedOver([billed('r1', 1, 1)], ['r1']);

    const { breakdown, text } = await costBreakdownOf({ runIds: ['r1'], recordsOf: () => [{ kind: 'responded', seq: 1, step: 1, attempt: 1 }], fetchPage });

    expect(breakdown.calls).toBe(1);
    expect(breakdown.duration).toBeNull();
    expect(text).toContain('duration: not recorded');
  });
});
