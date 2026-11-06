import { describe, expect, it } from 'vitest';
import { TARGET_PROBING, TARGET_PROBING_MESSAGE } from '@momonga/protocol';
import { GatewayRequestError } from '@momonga/runtime';
import { makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';

const PROBING_RETRY_AFTER_MS = 120_000;

const probing = (): GatewayRequestError =>
  new GatewayRequestError({ status: 503, type: 'server_error', code: TARGET_PROBING, message: TARGET_PROBING_MESSAGE, retryAfterMs: PROBING_RETRY_AFTER_MS });

describe('a target that the gateway is measuring', () => {
  it('spends no attempt while the gateway measures: it records no attempt.failed, shows the measuring notice and requeues at exactly Retry-After', async () => {
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
    expect(requeued.attempts).toBe(0);
    expect(requeued.availableAt - env.clock.now()).toBe(PROBING_RETRY_AFTER_MS);
    expect(env.events(run.id).filter((event) => event.type === 'attempt.failed')).toEqual([]);
    expect(env.events(run.id).filter((event) => event.type === 'notice')).toEqual([expect.objectContaining({ code: TARGET_PROBING, message: TARGET_PROBING_MESSAGE })]);
    expect(env.gateway.streams).toEqual([]);

    measuring = false;
    env.clock.set(requeued.availableAt);
    expect(await env.runOnce(worker)).toBe('yielded');
    expect(env.run(run.id)).toMatchObject({ status: 'COMPLETED', attempts: 1 });
  });

  it('still counts a transient failure after the probe ends as an attempt', async () => {
    const env = await makeEnv();
    env.gateway.capabilitiesHook = async () => {
      throw new GatewayRequestError({ status: 502, type: 'server_error', code: 'provider_unavailable', message: 'the upstream is unreachable' });
    };
    const run = env.enqueue('Work');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).attempts).toBe(1);
    expect(env.events(run.id).filter((event) => event.type === 'attempt.failed')).toHaveLength(1);
  });
});
