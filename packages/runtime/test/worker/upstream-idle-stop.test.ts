import { describe, expect, it } from 'vitest';
import { GatewayRequestError } from '@momonga/runtime';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { textStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';

const IDLE_TEXT = 'The model sent no output for 300 s (only keep-alive signals arrived), so the call was stopped. Raise models.idleTimeoutMs if this model needs longer.';

const idleStopBeforeOutput = (): ScriptStep => ({
  events: [],
  error: new GatewayRequestError({ status: 502, type: 'server_error', code: 'stream_interrupted', message: IDLE_TEXT }),
});

const claimOnce = async (env: Env, worker: ReturnType<Env['worker']>): Promise<void> => {
  expect(await env.runOnce(worker)).toBe('yielded');
};

describe('G1 test 7: a keep-alive-only upstream ends with the idle stop, and the run follows the cut-stream policy', () => {
  it('requeues each idle stop, refunds the first three, counts the fourth, and completes once the model answers, long before the run deadline', async () => {
    const env = await makeEnv();
    env.gateway.script.push(idleStopBeforeOutput(), idleStopBeforeOutput(), idleStopBeforeOutput(), idleStopBeforeOutput(), textStep('Answered.'));
    const deadlineAt = env.clock.now() + 6 * 60 * 60 * 1000;
    const run = env.enqueue('Work', { deadlineAt });
    const worker = env.worker('worker-1', { random: () => 0.5 });
    const attempts: number[] = [];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await claimOnce(env, worker);
      const current = env.run(run.id);
      expect(current.status).toBe('QUEUED');
      attempts.push(current.attempts);
      env.clock.set(Math.max(env.clock.now(), current.availableAt));
    }
    await claimOnce(env, worker);
    expect(attempts).toEqual([0, 0, 0, 1]);
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.clock.now()).toBeLessThan(deadlineAt);
    expect(env.gateway.streams).toHaveLength(5);
  });
});
