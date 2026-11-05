import { describe, expect, it } from 'vitest';
import { startService, waitUntil } from './helpers.ts';

describe('cancelUpstream', () => {
  it('is called once with the run id after a QUEUED run is cancelled', async () => {
    const calls: { runId: string; status: string | undefined }[] = [];
    const holder: { env?: Awaited<ReturnType<typeof startService>> } = {};
    const env = await startService({
      sweepIntervalMs: 20,
      cancelUpstream: async (runId) => {
        calls.push({ runId, status: holder.env?.store.getRun(runId)?.status });
      },
    });
    holder.env = env;
    const session = await env.createSession();
    const run = await env.createRun(session.id);

    const response = await env.http('POST', `/v1/runs/${run.id}/cancel`);

    expect(response.status).toBe(202);
    await waitUntil(() => calls.length > 0, 3_000, 'cancelUpstream to be called');
    expect(calls).toEqual([{ runId: run.id, status: 'CANCELLED' }]);
  });

  it('is not called when a RUNNING run moves to CANCELLING', async () => {
    const calls: string[] = [];
    const env = await startService({
      cancelUpstream: async (runId) => {
        calls.push(runId);
      },
    });
    const session = await env.createSession();
    const run = await env.createRun(session.id);
    env.claimRun(run.id);

    const response = await env.http('POST', `/v1/runs/${run.id}/cancel`);

    expect(response.json.run.status).toBe('CANCELLING');
    expect(calls).toEqual([]);
  });

  it('reports a cancelUpstream failure to onError and still answers 202', async () => {
    const failure = new Error('the gateway refused the cancel');
    const env = await startService({
      sweepIntervalMs: 20,
      cancelUpstream: async () => {
        throw failure;
      },
    });
    const session = await env.createSession();
    const run = await env.createRun(session.id);

    const response = await env.http('POST', `/v1/runs/${run.id}/cancel`);

    expect(response.status).toBe(202);
    expect(response.json.run.status).toBe('CANCELLING');
    await waitUntil(() => env.errors.length > 0, 3_000, 'the failure to reach onError');
    expect(env.errors).toEqual([failure]);
  });
});
