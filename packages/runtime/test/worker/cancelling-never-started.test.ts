import { describe, expect, it } from 'vitest';
import { makeEnv, typesOf } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

describe('a run that is CANCELLING and never started', () => {
  it('is claimed by a worker and ends CANCELLED without a model call', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('never sent'));
    const run = env.enqueue('Work');
    env.raw().prepare("UPDATE runs SET status = 'CANCELLING', cancel_requested = 1 WHERE id = ?").run(run.id);
    expect(env.run(run.id)).toMatchObject({ status: 'CANCELLING', leaseOwner: null });

    expect(await env.runOnce(env.worker('worker-1'))).toBe('yielded');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.gateway.streams).toHaveLength(0);
    const types = typesOf(env.events(run.id));
    expect(types.at(-1)).toBe('run.status');
    expect(types).not.toContain('model.requested');
  });

  it('from WAITING_HUMAN with a pending approval is claimed and ends CANCELLED, and no call of such a run is started', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: `${env.project}/out.txt`, content: 'x' } }]));
    const run = env.enqueue('Write the file');
    expect(await env.runOnce(env.worker('worker-1'))).toBe('yielded');
    expect(env.run(run.id).status).toBe('WAITING_HUMAN');
    expect(env.store.approvals.listPending(run.id)).toHaveLength(1);
    expect(Object.values(env.fold(run.id).pendingCalls).map((call) => call.status)).toEqual(['awaiting_approval']);
    env.raw().prepare("UPDATE runs SET status = 'CANCELLING', cancel_requested = 1 WHERE id = ?").run(run.id);

    expect(await env.runOnce(env.worker('worker-2'))).toBe('yielded');

    expect(env.run(run.id).status).toBe('CANCELLED');
    expect(env.toolbox.executions).toEqual([]);
    expect(env.gateway.streams).toHaveLength(1);
    expect(env.store.approvals.listPending(run.id)).toEqual([]);
  });

  it('waits for no lease and no backoff: a parent-less QUEUED run turned CANCELLING is claimable at once', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work');
    env.raw().prepare("UPDATE runs SET status = 'CANCELLING', cancel_requested = 1 WHERE id = ?").run(run.id);

    const claim = env.store.claim('worker-1');

    expect(claim).toMatchObject({ runId: run.id, status: 'CANCELLING' });
  });
});
