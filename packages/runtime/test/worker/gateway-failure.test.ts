import { describe, expect, it } from 'vitest';
import { makeEnv, modelKey } from './harness.ts';
import { GatewayRequestError } from '../../src/gateway-client.ts';
import { failedStep, textStep, thrownStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';

const gatewayErrorStep = (fields: ConstructorParameters<typeof GatewayRequestError>[0]): ScriptStep => ({ events: [], error: new GatewayRequestError(fields) });

const REQUEUED: [string, () => ScriptStep][] = [
  ['a thrown stream error', () => thrownStep()],
  [
    'a gateway_unavailable proven not sent',
    () => gatewayErrorStep({ status: 503, type: 'transport', code: 'gateway_unavailable', message: 'the gateway socket refused the connection', provenNotSent: true }),
  ],
  ['a gateway_closed 503', () => gatewayErrorStep({ status: 503, type: 'server_error', code: 'gateway_closed', message: 'the gateway is shutting down' })],
  ['a stream_interrupted', () => gatewayErrorStep({ status: 502, type: 'server_error', code: 'stream_interrupted', message: 'the gateway stream ended before a terminal event' })],
];

describe('worker gateway failures', () => {
  it.each(REQUEUED)('requeues with backoff after %s and re-sends the same key and body', async (_label, failure) => {
    const env = await makeEnv();
    env.gateway.script.push(failure(), textStep('Recovered.'));
    const run = env.enqueue('Work');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    const released = env.run(run.id);
    expect(released.status).toBe('QUEUED');
    expect(released.availableAt).toBeGreaterThanOrEqual(env.clock.now());
    expect(released.leaseOwner).toBeNull();
    expect(env.ofType(run.id, 'run.status').at(-1)).toMatchObject({ from: 'RUNNING', to: 'QUEUED' });
    expect(env.ofType(run.id, 'model.responded')).toEqual([]);

    env.clock.set(released.availableAt);
    expect(await env.runOnce(env.worker('worker-2'))).toBe('yielded');

    expect(env.run(run.id).status).toBe('COMPLETED');
    const [first, second] = env.gateway.streams;
    expect(env.gateway.streams).toHaveLength(2);
    expect(first?.idempotencyKey).toBe(modelKey(run.id, 1, 1));
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(second?.body).toEqual(first?.body);
    expect(env.gateway.generations.get(modelKey(run.id, 1, 1))).toBe(2);
    expect(env.ofType(run.id, 'model.requested')).toHaveLength(1);
    expect(env.ofType(run.id, 'model.responded')).toEqual([expect.objectContaining({ step: 1, attempt: 1 })]);
  });

  it('fails the step on the first claim after a server_error that the gateway returned once its retry budget was spent', async () => {
    const env = await makeEnv({ maxAttempts: 20, maxTotalAttempts: 20 });
    env.gateway.script.push(
      gatewayErrorStep({ status: 502, type: 'server_error', code: 'upstream_error', message: 'the upstream responded with HTTP 503' }),
      textStep('never sent'),
    );
    const run = env.enqueue('Work');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    const after = env.run(run.id);
    expect(after.status).toBe('FAILED');
    expect(after.error).toEqual({ code: 'upstream_error', message: 'the upstream responded with HTTP 503' });
    expect(env.ofType(run.id, 'run.status').some((event) => event.to === 'QUEUED')).toBe(false);
    expect(env.gateway.streams).toHaveLength(1);
    expect(env.gateway.script).toHaveLength(1);
  });

  it('dead-letters the run as FAILED once the store attempt limit is exhausted', async () => {
    const env = await makeEnv({ maxAttempts: 3, maxTotalAttempts: 3 });
    env.gateway.script.push(failedStep('upstream_unavailable'), failedStep('upstream_unavailable'), failedStep('upstream_unavailable'), textStep('never sent'));
    const run = env.enqueue('Work');

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      expect(await env.runOnce(env.worker(`worker-${attempt}`))).toBe('yielded');
      const current = env.run(run.id);
      expect(current.status).toBe('QUEUED');
      env.clock.set(Math.max(env.clock.now(), current.availableAt));
    }

    expect(await env.runOnce(env.worker('worker-3'))).toBe('yielded');
    const final = env.run(run.id);
    expect(final.status).toBe('FAILED');
    expect(final.error?.code).toBe('max_total_attempts');
    expect(final.error?.message).toBe(`run ${run.id} exceeded 3 total attempts; the last attempt failed with: upstream_unavailable: upstream failed with upstream_unavailable`);
    expect(env.gateway.streams).toHaveLength(3);
    expect(new Set(env.gateway.streams.map((stream) => stream.idempotencyKey))).toEqual(new Set([modelKey(run.id, 1, 1)]));
    expect(env.gateway.script).toHaveLength(1);
  });
});
