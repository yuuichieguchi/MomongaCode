import { describe, expect, it } from 'vitest';
import { makeEnv } from './harness.ts';
import { gated, textStep } from './scripts.ts';

const FLUSH_INTERVAL_MS = 50;

describe('the delta flush of a model stream runs on the timing port of the worker', () => {
  it('writes the buffered text when the fake timers pass the flush interval, while the stream is still open', async () => {
    const env = await makeEnv();
    const blocked = gated(textStep('Hello world', { chunks: ['Hello ', 'world'] }), 6);
    env.gateway.script.push(blocked);
    const run = await env.enqueue('Talk');
    const running = env.runOnce(env.worker());
    await env.settled(blocked.gate.reached.promise, 'the stream to start');

    expect(env.ofType(run.id, 'agent.message.delta')).toEqual([]);
    expect(env.timers.pending().some((timer) => timer.delayMs === FLUSH_INTERVAL_MS)).toBe(true);
    env.timers.advance(FLUSH_INTERVAL_MS);
    expect(env.ofType(run.id, 'agent.message.delta').map((event) => event.text).join('')).toBe('Hello world');

    blocked.gate.release.resolve();
    await env.settled(running, 'the worker');
    expect(env.run(run.id).status).toBe('COMPLETED');
  });
});
