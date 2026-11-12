import { describe, expect, it } from 'vitest';
import { createScriptedAdapter } from '@momonga/testkit';
import type { RunSpansPage } from '@momonga/protocol';
import { readJson, startGateway } from './gateway-helpers.ts';

const PAGE: RunSpansPage = {
  spans: [{ traceId: 't', spanId: 's1', parentSpanId: null, name: 'chat gpt-x', kind: 'CLIENT', startMs: 1, endMs: 2, status: 'OK', attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 7 } }],
  next: null,
};

describe('GET /v1/momonga/spans: the gateway answers the spans it holds for a run', () => {
  it('answers one page of the spans of the run asked for, from the cursor', async () => {
    const asked: { runId: string; after: number; limit: number }[] = [];
    const h = await startGateway({
      adapters: { 'scripted/scripted-primary': createScriptedAdapter({ calls: [] }) },
      traceSpans: async (runId, after, limit) => {
        asked.push({ runId, after, limit });
        return PAGE;
      },
    });

    const reply = await readJson(await h.client.request({ method: 'GET', path: '/v1/momonga/spans?run_id=run-1&after=4&limit=10' }));

    expect(reply).toMatchObject({ status: 200, body: PAGE });
    expect(asked).toEqual([{ runId: 'run-1', after: 4, limit: 10 }]);
  });

  it('refuses a request with no run id and a page size out of bounds', async () => {
    const h = await startGateway({ adapters: { 'scripted/scripted-primary': createScriptedAdapter({ calls: [] }) }, traceSpans: async () => PAGE });

    expect((await readJson(await h.client.request({ method: 'GET', path: '/v1/momonga/spans' }))).status).toBe(400);
    expect((await readJson(await h.client.request({ method: 'GET', path: '/v1/momonga/spans?run_id=run-1&limit=0' }))).status).toBe(400);
  });
});
