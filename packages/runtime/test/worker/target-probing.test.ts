import { describe, expect, it } from 'vitest';
import { TARGET_PROBING, TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import { GatewayRequestError } from '@momonga/runtime';
import { makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';

const PROBING_RETRY_AFTER_MS = 120_000;

const probing = (): GatewayRequestError =>
  new GatewayRequestError({ status: 503, type: 'server_error', code: TARGET_PROBING, message: TARGET_PROBING_MESSAGE, retryAfterMs: PROBING_RETRY_AFTER_MS });

describe('a target that the gateway is measuring', () => {
  it('takes the transient path: records attempt.failed target_probing and requeues the run at Retry-After within the attempt limit', async () => {
    const env = await makeEnv();
    let measuring = true;
    env.gateway.capabilitiesHook = async () => {
      if (measuring) throw probing();
    };
    env.gateway.script.push(textStep('Measured and done.'));
    const run = env.enqueue('Work');
    const worker = env.worker();

    expect(await env.runOnce(worker)).toBe('yielded');

    const requeued = env.run(run.id);
    expect(requeued.status).toBe('QUEUED');
    expect(requeued.attempts).toBe(1);
    expect(requeued.availableAt - env.clock.now()).toBeGreaterThanOrEqual(PROBING_RETRY_AFTER_MS);
    expect(env.events(run.id).filter((event) => event.type === 'attempt.failed')).toEqual([expect.objectContaining({ attempt: 1, code: TARGET_PROBING })]);
    expect(env.gateway.streams).toEqual([]);

    measuring = false;
    env.clock.set(requeued.availableAt);
    expect(await env.runOnce(worker)).toBe('yielded');
    expect(env.run(run.id).status).toBe('COMPLETED');
  });
});
