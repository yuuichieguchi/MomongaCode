import { describe, expect, it } from 'vitest';
import { REPORT_PAGE_ROWS } from '@momonga/protocol';
import type { RunCallView } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { startService } from './helpers.ts';

type Facts = { commit(batch: { rows: readonly []; unavailable: readonly string[]; calls: readonly RunCallView[]; throughEventId: number }): void };

const factsOf = (store: RuntimeStore): Facts => (store as unknown as { runFacts: Facts }).runFacts;

const withCalls = async (overrides: Parameters<typeof startService>[0] = {}) => {
  const env = await startService(overrides);
  const session = await env.createSession();
  const run = await env.createRun(session.id, { input: 'one' });
  const calls: RunCallView[] = [
    { runId: run.id, callId: 'call-1', basis: 'rule', sideEffect: 'write', asked: false },
    { runId: run.id, callId: 'call-2', basis: 'person', sideEffect: 'exec', asked: true },
    { runId: run.id, callId: 'call-3', basis: 'read_only', sideEffect: 'read_only', asked: false },
  ];
  factsOf(env.store).commit({ rows: [], unavailable: [], calls, throughEventId: 0 });
  return { env, run, calls };
};

describe('/v1/report/reviews', () => {
  it('GET pages the calls of the record with the labels stored for them', async () => {
    const { env, run, calls } = await withCalls();
    const stored = await env.http('POST', '/v1/report/reviews', { body: { runId: run.id, callId: 'call-2', label: 'unneeded_ask' } });
    expect(stored.status).toBe(201);
    expect(stored.json.review).toMatchObject({ runId: run.id, callId: 'call-2', label: 'unneeded_ask', reviewedAt: expect.any(Number) });

    const first = await env.http('GET', '/v1/report/reviews?limit=2');
    expect(first.status).toBe(200);
    expect(first.json.calls).toEqual(calls.slice(0, 2));
    expect(first.json.reviews).toEqual([stored.json.review]);
    const last = await env.http('GET', `/v1/report/reviews?limit=2&cursor=${encodeURIComponent(first.json.nextCursor as string)}`);
    expect(last.json.calls).toEqual(calls.slice(2));
    expect(last.json.reviews).toEqual([]);
    expect(last.json.nextCursor).toBeNull();
  });

  it('refuses a limit above REPORT_PAGE_ROWS, a label outside the three, and a call the record does not hold', async () => {
    const { env, run } = await withCalls();
    expect((await env.http('GET', `/v1/report/reviews?limit=${REPORT_PAGE_ROWS + 1}`)).status).toBe(400);
    expect((await env.http('POST', '/v1/report/reviews', { body: { runId: run.id, callId: 'call-1', label: 'wrong' } })).status).toBe(400);
    expect((await env.http('POST', '/v1/report/reviews', { body: { runId: run.id, callId: 'call-1' } })).status).toBe(400);
    const missing = await env.http('POST', '/v1/report/reviews', { body: { runId: run.id, callId: 'call-9', label: 'correct' } });
    expect(missing.status).toBe(404);
    expect(missing.json.error.message).toContain('call-9');
  });
});

describe('POST /v1/report/cost', () => {
  it('answers the cost rows of the asked run ids, at most REPORT_PAGE_ROWS of them', async () => {
    const asked: string[][] = [];
    const row = { runId: 'run-a', calls: 2, retries: 0, notPriced: 1, priced: [{ currency: 'USD', priceVersion: '2026-01-01', units: '12' }] };
    const { env } = await withCalls({
      reportCost: async (runIds) => {
        asked.push([...runIds]);
        return [row];
      },
    });
    const response = await env.http('POST', '/v1/report/cost', { body: { runIds: ['run-a'] } });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ costs: [row] });
    expect(asked).toEqual([['run-a']]);

    const tooMany = Array.from({ length: REPORT_PAGE_ROWS + 1 }, (_unused, index) => `run-${index}`);
    expect((await env.http('POST', '/v1/report/cost', { body: { runIds: tooMany } })).status).toBe(400);
    expect((await env.http('POST', '/v1/report/cost', { body: { runIds: ['run-a', 'run-a'] } })).status).toBe(400);
    expect((await env.http('POST', '/v1/report/cost', { body: { runIds: 'run-a' } })).status).toBe(400);
    expect(asked).toHaveLength(1);
  });
});

describe('GET /v1/runs/:id/trace/content', () => {
  it('answers one page of the stored bodies of the run after the cursor', async () => {
    const asked: { runId: string; after: number; limit: number }[] = [];
    const page = { bodies: [{ id: 4, spanId: 'span-1', kind: 'gen_ai.input.messages', content: 'hello', createdAtMs: 1, expiresAtMs: 2 }], next: 4 };
    const { env, run } = await withCalls({
      runTraceContent: async (runId, after, limit) => {
        asked.push({ runId, after, limit });
        return page;
      },
    });
    const response = await env.http('GET', `/v1/runs/${run.id}/trace/content?after=3&limit=1`);
    expect(response.status).toBe(200);
    expect(response.json).toEqual(page);
    expect(asked).toEqual([{ runId: run.id, after: 3, limit: 1 }]);
    expect((await env.http('GET', `/v1/runs/${run.id}/trace/content?after=-1&limit=1`)).status).toBe(400);
    expect((await env.http('GET', `/v1/runs/${run.id}/trace/content?after=0&limit=0`)).status).toBe(400);
    expect((await env.http('GET', '/v1/runs/run-missing/trace/content?after=0&limit=1')).status).toBe(404);
  });
});
