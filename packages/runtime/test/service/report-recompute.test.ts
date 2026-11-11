import { describe, expect, it } from 'vitest';
import { REPORT_PAGE_ROWS } from '@momonga/protocol';
import type { RunFactsRecord } from '@momonga/protocol';
import { FactsRefusedError } from '@momonga/store';
import { recomputeFactsOf } from '../../src/service/facts-sweeper.ts';
import { startService } from './helpers.ts';

describe('POST /v1/report/recompute', () => {
  it('answers the facts folded again for the asked run ids and refuses more than REPORT_PAGE_ROWS', async () => {
    const asked: string[][] = [];
    const env = await startService({
      recomputeFacts: async (runIds) => {
        asked.push([...runIds]);
        return { rows: [], refused: [...runIds] };
      },
    });
    const response = await env.http('POST', '/v1/report/recompute', { body: { runIds: ['run-a'] } });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ rows: [], refused: ['run-a'] });
    const tooMany = Array.from({ length: REPORT_PAGE_ROWS + 1 }, (_unused, index) => `run-${index}`);
    expect((await env.http('POST', '/v1/report/recompute', { body: { runIds: tooMany } })).status).toBe(400);
    expect(asked).toEqual([['run-a']]);
  });
});

describe('recomputeFactsOf', () => {
  it('folds each run through the journal thread, lists a refused run as refused and lets any other failure through', async () => {
    const facts = { runId: 'run-a' } as unknown as RunFactsRecord['facts'];
    const thread = {
      runFacts: async (runId: string): Promise<RunFactsRecord> => {
        if (runId === 'run-gone') throw new FactsRefusedError('the journal of run-gone cannot be folded');
        if (runId === 'run-broken') throw new Error('the thread is gone');
        return { facts, calls: [] };
      },
    };
    const signal = new AbortController().signal;
    expect(await recomputeFactsOf(thread, ['run-a', 'run-gone'], signal)).toEqual({ rows: [facts], refused: ['run-gone'] });
    await expect(recomputeFactsOf(thread, ['run-broken'], signal)).rejects.toThrow('the thread is gone');
  });
});
