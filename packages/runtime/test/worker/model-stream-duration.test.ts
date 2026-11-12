import { describe, expect, it } from 'vitest';
import { makeEnv } from './harness.ts';
import { gated, textStep } from './scripts.ts';

const HOUR_MS = 3_600_000;
const CALL_MS = 1_500;

describe('the elapsed times of a model call are measured on the monotonic clock', () => {
  it('records the duration the monotonic clock measured although the wall clock stepped back an hour during the call', async () => {
    const env = await makeEnv();
    const blocked = gated(textStep('Done.'), 1);
    env.gateway.script.push(blocked);
    const run = await env.enqueue('Work');
    const running = env.runOnce(env.worker());
    await env.settled(blocked.gate.reached.promise, 'the stream to start');

    env.clock.stepWall(-HOUR_MS);
    env.clock.advance(CALL_MS);
    blocked.gate.release.resolve();
    await env.settled(running, 'the worker');

    expect(env.run(run.id).status).toBe('COMPLETED');
    const timing = env.ofType(run.id, 'model.responded')[0]?.response.timing;
    expect(timing?.durationMs).toBeGreaterThanOrEqual(CALL_MS);
    expect(timing?.durationMs).toBeLessThan(HOUR_MS);
    expect(timing?.firstEventMs).toBeGreaterThanOrEqual(0);
  });
});
