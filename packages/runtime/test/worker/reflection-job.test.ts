import { describe, expect, it } from 'vitest';
import { makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';

describe('worker and the reflection job', () => {
  it('writes the job row in the terminal transition of a run that completes', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Done.'));
    const run = await env.enqueue('Say hello');
    expect(env.store.reflection.get(run.id)).toBeUndefined();

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.store.reflection.get(run.id)).toMatchObject({ runId: run.id, state: 'pending', attempts: 0, lastError: null });
  });

  it('writes no row for a run that was cancelled while queued', async () => {
    const env = await makeEnv();
    const run = await env.enqueue('Never started');
    expect((await env.cancelToEnd(run.id)).status).toBe('CANCELLED');
    expect(env.store.reflection.get(run.id)).toBeUndefined();
  });
});
