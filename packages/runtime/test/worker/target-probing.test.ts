import { describe, expect, it } from 'vitest';
import { TARGET_PROBE_FAILED, TARGET_PROBING, TARGET_PROBING_MESSAGE, measuringLineOf, measuringSkipOf } from '@momonga/protocol';
import type { Measuring } from '@momonga/protocol';
import { GatewayRequestError, MEASURING_SAME_STATE_WAITS } from '@momonga/runtime';
import { makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';

const PROBING_RETRY_AFTER_MS = 120_000;

const stateAt = (step: string | null, elapsedSeconds: number): Measuring => ({ fields: ['toolCalling'], step, elapsedSeconds, declaration: 'declare toolCalling for the model in its settings' });

const probing = (measuring: Measuring = stateAt(null, 0)): GatewayRequestError =>
  new GatewayRequestError({ status: 503, type: 'server_error', code: TARGET_PROBING, message: TARGET_PROBING_MESSAGE, retryAfterMs: PROBING_RETRY_AFTER_MS, measuring });

describe('a model that the gateway is measuring', () => {
  it('spends no attempt while the gateway measures: it records no attempt.failed, shows the measuring state and requeues at exactly Retry-After', async () => {
    const env = await makeEnv();
    let measuring = true;
    env.gateway.capabilitiesHook = async () => {
      if (measuring) throw probing();
    };
    env.gateway.script.push(textStep('Measured and done.'));
    const run = await env.enqueue('Work');
    const worker = env.worker();

    expect(await env.runOnce(worker)).toBe('yielded');

    const requeued = env.run(run.id);
    expect(requeued.status).toBe('QUEUED');
    expect(requeued.attempts).toBe(0);
    expect(requeued.availableAt - env.clock.now()).toBe(PROBING_RETRY_AFTER_MS);
    expect(env.events(run.id).filter((event) => event.type === 'attempt.failed')).toEqual([]);
    expect(env.events(run.id).filter((event) => event.type === 'notice')).toEqual([expect.objectContaining({ code: TARGET_PROBING, message: measuringLineOf(stateAt(null, 0)) })]);
    expect(env.gateway.streams).toEqual([]);

    measuring = false;
    env.clock.set(requeued.availableAt);
    expect(await env.runOnce(worker)).toBe('yielded');
    expect(env.run(run.id)).toMatchObject({ status: 'COMPLETED', attempts: 1 });
  });

  it('shows one line per measuring state, not one per wait', async () => {
    const env = await makeEnv();
    const states = [stateAt(null, 0), stateAt('plain answer', 5), stateAt('plain answer', 9), stateAt('tool call', 20)];
    let index = 0;
    env.gateway.capabilitiesHook = async () => {
      const state = states[index];
      index += 1;
      if (state !== undefined) throw probing(state);
    };
    env.gateway.script.push(textStep('Measured and done.'));
    const run = await env.enqueue('Work');
    const worker = env.worker();

    for (let wait = 0; wait < states.length; wait += 1) {
      expect(await env.runOnce(worker)).toBe('yielded');
      env.clock.set(env.run(run.id).availableAt);
    }
    expect(await env.runOnce(worker)).toBe('yielded');

    expect(env.run(run.id)).toMatchObject({ status: 'COMPLETED' });
    expect(env.events(run.id).filter((event) => event.type === 'notice' && event.code === TARGET_PROBING).map((event) => (event.type === 'notice' ? event.message : ''))).toEqual([
      measuringLineOf(stateAt(null, 0)),
      measuringLineOf(stateAt('plain answer', 5)),
      measuringLineOf(stateAt('tool call', 20)),
    ]);
  });

  it('ends the run with the declaration that makes the measurement unnecessary when the state does not move for a bounded number of waits', async () => {
    const env = await makeEnv();
    const stuck = stateAt('tool call', 20);
    env.gateway.capabilitiesHook = async () => {
      throw probing(stuck);
    };
    const run = await env.enqueue('Work');
    const worker = env.worker();

    for (let wait = 0; wait < MEASURING_SAME_STATE_WAITS; wait += 1) {
      expect(await env.runOnce(worker)).toBe('yielded');
      expect(env.run(run.id).status).toBe('QUEUED');
      env.clock.set(env.run(run.id).availableAt);
    }
    expect(await env.runOnce(worker)).toBe('yielded');

    const ended = env.run(run.id);
    expect(ended.status).toBe('FAILED');
    expect(ended.error?.code).toBe(TARGET_PROBING);
    expect(ended.error?.message).toContain(measuringSkipOf(stuck));
  });

  it('never waits or retries on a failed measurement: the run ends with the cause the gateway names', async () => {
    const env = await makeEnv();
    let asked = 0;
    env.gateway.capabilitiesHook = async () => {
      asked += 1;
      throw new GatewayRequestError({ status: 503, type: 'server_error', code: TARGET_PROBE_FAILED, message: 'measuring this model failed: no answer; to skip it, declare toolCalling' });
    };
    const run = await env.enqueue('Work');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(asked).toBe(1);
    const ended = env.run(run.id);
    expect(ended.status).toBe('FAILED');
    expect(ended.error?.message).toContain('measuring this model failed: no answer; to skip it, declare toolCalling');
    expect(env.events(run.id).filter((event) => event.type === 'notice' && event.code === TARGET_PROBE_FAILED)).toEqual([]);
  });

  it('still counts a transient failure after the probe ends as an attempt', async () => {
    const env = await makeEnv();
    env.gateway.capabilitiesHook = async () => {
      throw new GatewayRequestError({ status: 502, type: 'server_error', code: 'provider_unavailable', message: 'the upstream is unreachable' });
    };
    const run = await env.enqueue('Work');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).attempts).toBe(1);
    expect(env.events(run.id).filter((event) => event.type === 'attempt.failed')).toHaveLength(1);
  });
});
