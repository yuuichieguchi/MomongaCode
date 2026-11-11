import { describe, expect, it } from 'vitest';

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
    await env.passTime(() => env.run(second.id).status === 'COMPLETED', 'both runs to complete');
    await env.settled(worker.stop(), 'the worker to stop');

    expect(env.run(first.id).status).toBe('COMPLETED');
    expect(env.gateway.streams).toHaveLength(2);
  });
});
