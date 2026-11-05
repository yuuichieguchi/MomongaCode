import { describe, expect, it } from 'vitest';
import { makeEnv, typesOf } from './harness.ts';
import { textStep } from './scripts.ts';

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

  it('waits for no lease and no backoff: a parent-less QUEUED run turned CANCELLING is claimable at once', async () => {
    const env = await makeEnv();
    const run = env.enqueue('Work');
    env.raw().prepare("UPDATE runs SET status = 'CANCELLING', cancel_requested = 1 WHERE id = ?").run(run.id);

    const claim = env.store.claim('worker-1');

    expect(claim).toMatchObject({ runId: run.id, status: 'CANCELLING' });
  });
});
