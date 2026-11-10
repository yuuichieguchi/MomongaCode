import { describe, expect, it, vi } from 'vitest';
import { UPSTREAM_IDLE_CODE, upstreamIdleText } from '@momonga/gateway';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { makeEnv } from './harness.ts';
import { answer, keepAliveOnly, startRealGateway, within } from './keep-alive-gateway.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const IDLE_MS = 300;
const CYCLE_WINDOW_MS = 20 * IDLE_MS;

describe('G1 test 7: a keep-alive-only upstream ends with the idle stop under the default retry policy, the gateway does not retry it, and the run follows the cut-stream policy; the breaker is held closed so that each requeued attempt reaches the one target', () => {
  it('requeues each idle stop of the real gateway, refunds the first three, counts the fourth, and completes once the model answers, long before the run deadline', async () => {
    const env = await makeEnv();
    const real = await startRealGateway({ clock: env.clock, idleTimeoutMs: IDLE_MS, script: [keepAliveOnly, keepAliveOnly, keepAliveOnly, keepAliveOnly, answer('Answered.')] });
    const deadlineAt = env.clock.now() + 6 * 60 * 60 * 1000;
    const run = env.enqueue('Work', { deadlineAt });
    const worker = env.worker('worker-1', { gateway: real.client, random: () => 0.5 });
    const attempts: number[] = [];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      expect(await within(env.runOnce(worker), CYCLE_WINDOW_MS)).toEqual({ settled: true, value: 'yielded' });
      const current = env.run(run.id);
      expect(current.status).toBe('QUEUED');
      attempts.push(current.attempts);
      env.clock.set(Math.max(env.clock.now(), current.availableAt));
    }
    expect(await within(env.runOnce(worker), CYCLE_WINDOW_MS)).toEqual({ settled: true, value: 'yielded' });
    expect(attempts).toEqual([0, 0, 0, 1]);
    expect(env.ofType(run.id, 'attempt.failed').map((event) => event.code)).toEqual([UPSTREAM_IDLE_CODE, UPSTREAM_IDLE_CODE, UPSTREAM_IDLE_CODE, UPSTREAM_IDLE_CODE]);
    expect(env.ofType(run.id, 'notice').map((event) => event.message)).toContain(`The attempt failed and will be retried: ${upstreamIdleText(IDLE_MS)}`);
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.clock.now()).toBeLessThan(deadlineAt);
    expect(real.upstream.requests.filter((request) => request.path === '/v1/chat/completions')).toHaveLength(5);
  });
});
