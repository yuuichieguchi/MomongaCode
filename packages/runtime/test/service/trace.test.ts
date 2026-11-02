import { describe, expect, it } from 'vitest';
import type { RunTraceView } from '@momonga/protocol';
import { expectError, expectSchema, startService } from './helpers.ts';

const TRACE: RunTraceView = {
  runId: 'placeholder',
  summary: { steps: 1, chatCalls: 0, toolCalls: 1, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, errorCount: 0, durationMs: 12, chatResults: [] },
  spans: [
    { traceId: 't', spanId: 's1', parentSpanId: null, name: 'invoke_agent momonga', kind: 'INTERNAL', startMs: 1, endMs: 13, status: 'UNSET', attributes: { 'gen_ai.operation.name': 'invoke_agent' } },
    { traceId: 't', spanId: 's2', parentSpanId: 's1', name: 'execute_tool Read', kind: 'INTERNAL', startMs: 2, endMs: 4, status: 'OK', attributes: { 'momonga.step': 1 } },
  ],
};

describe('GET /v1/runs/{id}/trace', () => {
  it('answers the trace the process recorded for the run, in the contract shape', async () => {
    const asked: string[] = [];
    const env = await startService({
      runTrace: async (runId) => {
        asked.push(runId);
        return { ...TRACE, runId };
      },
    });
    const session = await env.createSession();
    const run = await env.createRun(session.id);

    const response = await env.http('GET', `/v1/runs/${run.id}/trace`);

    expect(response.status).toBe(200);
    expectSchema('RunTrace', response.json);
    expect(response.json).toEqual({ ...TRACE, runId: run.id });
    expect(asked).toEqual([run.id]);
  });

  it('is 404 when nothing was recorded for the run yet', async () => {
    const env = await startService();
    const session = await env.createSession();
    const run = await env.createRun(session.id);

    expectError(await env.http('GET', `/v1/runs/${run.id}/trace`), 404, 'not_found');
  });

  it('is 404 for a run that does not exist and does not ask for its trace', async () => {
    const asked: string[] = [];
    const env = await startService({ runTrace: async (runId) => void asked.push(runId) });

    expectError(await env.http('GET', '/v1/runs/missing/trace'), 404, 'not_found');
    expect(asked).toEqual([]);
  });
});
