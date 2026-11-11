import { describe, expect, it } from 'vitest';
import { waitUntil, within } from './deferred.ts';
import { makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';

describe('worker poll loop', () => {
  it('claims queued runs after start and resolves stop once drained', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('First.'), textStep('Second.'));
    const first = await env.enqueue('one');
    const second = await env.enqueue('two');
    const worker = env.worker();

    worker.start();
    await waitUntil(() => env.run(second.id).status === 'COMPLETED', 10_000, 'both runs to complete');
    await within(worker.stop(), 5_000, 'the worker to stop');

    expect(env.run(first.id).status).toBe('COMPLETED');
    expect(env.gateway.streams).toHaveLength(2);
  });
});
