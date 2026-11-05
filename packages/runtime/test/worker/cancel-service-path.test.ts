import { describe, expect, it } from 'vitest';
import { createStoppedRunReleaser } from '../../src/process/release-stopped.ts';
import { createCancelUpstream } from '../../src/process/cancel-upstream.ts';
import type { ServiceTimers } from '../../src/service/timers.ts';
import { makeEnv, typesOf } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const finishAsTheSweeperWould = async (env: Env, runId: string) => {
  const upstream: string[] = [];
  const tracker = createCancelUpstream({
    store: env.store,
    gatewayClient: { cancel: async (key: string) => upstream.push(key) > 0 },
    timers: { setTimeout, clearTimeout } as unknown as ServiceTimers,
  });
  const release = createStoppedRunReleaser({
    store: env.store,
    tools: { envFor: (session) => ({ ...session.env }), toolSet: async () => env.snapshotTools([]), executor: env.executor },
  });
  await tracker.cancel(runId);
  await release(runId, new AbortController().signal);
  await tracker.settle(10);
  return upstream;
};

describe('the service-side finish of a cancelled run that never ran, with no worker involved', () => {
  it('a QUEUED run ends CANCELLED, releases and cancels upstream without a model call or an execution', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('never sent'));
    const run = env.enqueue('Work');

    expect(env.cancel(run.id).status).toBe('CANCELLED');
    const upstream = await finishAsTheSweeperWould(env, run.id);

    expect(env.run(run.id)).toMatchObject({ status: 'CANCELLED', leaseOwner: null });
    expect(upstream).toEqual([]);
    expect(env.toolbox.executions).toEqual([]);
    expect(env.gateway.streams).toHaveLength(0);
    expect(typesOf(env.events(run.id))).not.toContain('model.requested');
  });

  it('a WAITING_HUMAN run with a pending approval and an awaiting call ends CANCELLED with the approval withdrawn and nothing executed', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: `${env.project}/out.txt`, content: 'x' } }]));
    const run = env.enqueue('Write the file');
    expect(await env.runOnce(env.worker('worker-1'))).toBe('yielded');
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expect(env.store.approvals.listPending(run.id)).toHaveLength(1);
    expect(Object.values(env.fold(run.id).pendingCalls).map((call) => call.status)).toEqual(['awaiting_approval']);
    const streamsBefore = env.gateway.streams.length;

    expect(env.cancel(run.id).status).toBe('CANCELLED');
    await finishAsTheSweeperWould(env, run.id);

    expect(env.run(run.id)).toMatchObject({ status: 'CANCELLED', leaseOwner: null });
    expect(env.store.approvals.listPending(run.id)).toEqual([]);
    expect(env.toolbox.executions).toEqual([]);
    expect(env.gateway.streams).toHaveLength(streamsBefore);
  });
});
