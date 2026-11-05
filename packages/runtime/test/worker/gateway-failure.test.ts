import { describe, expect, it } from 'vitest';
import { makeEnv, modelKey } from './harness.ts';
import { GatewayRequestError } from '../../src/gateway-client.ts';
import { failedStep, textStep, thrownStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';
import { responseResource } from '@momonga/testkit';
import type { StreamEvent } from '@momonga/protocol';

const gatewayErrorStep = (fields: ConstructorParameters<typeof GatewayRequestError>[0]): ScriptStep => ({ events: [], error: new GatewayRequestError(fields) });

const REQUEUED: [string, () => ScriptStep][] = [
  ['a thrown stream error', () => thrownStep()],
  [
    'a gateway_unavailable proven not sent',
    () => gatewayErrorStep({ status: 503, type: 'transport', code: 'gateway_unavailable', message: 'the gateway socket refused the connection', provenNotSent: true }),
  ],
  ['a gateway_closed 503', () => gatewayErrorStep({ status: 503, type: 'server_error', code: 'gateway_closed', message: 'the gateway is shutting down' })],
  ['a stream_interrupted', () => gatewayErrorStep({ status: 502, type: 'server_error', code: 'stream_interrupted', message: 'the gateway stream ended before a terminal event' })],
  [
    'a 409 idempotency_key_in_progress',
    () => gatewayErrorStep({ status: 409, type: 'invalid_request', code: 'idempotency_key_in_progress', message: 'the key belongs to a request that is still running' }),
  ],
  ['a response.failed after output that the gateway marked retryable', () => failedAfterOutputStep(true)],
];

const DEFERRED_RETRY_AFTER_MS = 100_000;

const deferredStep = (): ScriptStep =>
  gatewayErrorStep({
    status: 429,
    type: 'too_many_requests',
    code: 'rate_limited',
    message: 'the upstream asked for a wait longer than the whole retry budget',
    retryAfterMs: DEFERRED_RETRY_AFTER_MS,
    deferred: true,
  } as ConstructorParameters<typeof GatewayRequestError>[0]);

function failedAfterOutputStep(retryable: boolean): ScriptStep {
  const text = textStep('partial answer').events;
  const firstDelta = text.findIndex((event) => event.type === 'response.output_text.delta');
  const base = responseResource({ id: 'resp_failed_after_output', model: 'fm', status: 'failed' });
  const failed = {
    type: 'response.failed',
    sequence_number: firstDelta + 1,
    response: {
      ...base,
      error: { code: 'stream_interrupted', message: 'the upstream stream was interrupted after output', type: 'server_error' },
      momonga: { alias: 'fm', target: 'scripted', counter: 'scripted-counter', attempts: 1, usageSource: 'estimated', retryable },
    },
  } as unknown as StreamEvent;
  return { events: [...text.slice(0, firstDelta + 1), failed] };
}

const FAILED_ON_FIRST_CLAIM: [string, () => ScriptStep, { code: string; message: string }][] = [
  [
    'an internal_error 500',
    () => gatewayErrorStep({ status: 500, type: 'server_error', code: 'internal_error', message: 'the gateway failed internally' }),
    { code: 'internal_error', message: 'the gateway failed internally' },
  ],
  [
    'a 429 rate_limited that the gateway did not mark as a deferral',
    () => gatewayErrorStep({ status: 429, type: 'too_many_requests', code: 'rate_limited', message: 'slow down', retryAfterMs: 20_000 }),
    { code: 'rate_limited', message: 'slow down' },
  ],
  ['a response.failed before any output', () => failedStep('upstream_unavailable'), { code: 'upstream_unavailable', message: 'upstream failed with upstream_unavailable' }],
  [
    'a response.failed after output that the gateway marked not retryable',
    () => failedAfterOutputStep(false),
    { code: 'stream_interrupted', message: 'the upstream stream was interrupted after output' },
  ],
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

  it.each(FAILED_ON_FIRST_CLAIM)('fails the step on the first claim after %s', async (_label, failure, error) => {
    const env = await makeEnv({ maxAttempts: 20, maxTotalAttempts: 20 });
    env.gateway.script.push(failure(), textStep('never sent'));
    const run = env.enqueue('Work');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    const after = env.run(run.id);
    expect(after.status).toBe('FAILED');
    expect(after.error).toEqual(error);
    expect(env.ofType(run.id, 'run.status').some((event) => event.to === 'QUEUED')).toBe(false);
    expect(env.gateway.streams).toHaveLength(1);
  });

  it('requeues a deferral at exactly its Retry-After time and then completes', async () => {
    const env = await makeEnv();
    env.gateway.script.push(deferredStep(), textStep('After the deferral.'));
    const run = env.enqueue('Work');
    const deferredAt = env.clock.now();

    expect(await env.runOnce(env.worker())).toBe('yielded');

    const released = env.run(run.id);
    expect(released.status).toBe('QUEUED');
    expect(released.availableAt).toBe(deferredAt + DEFERRED_RETRY_AFTER_MS);

    env.clock.set(released.availableAt);
    expect(await env.runOnce(env.worker('worker-2'))).toBe('yielded');
    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.streams).toHaveLength(2);
  });

  it('fails the step instead of requeueing a deferral whose Retry-After time is past the run deadline', async () => {
    const env = await makeEnv();
    env.gateway.script.push(deferredStep(), textStep('never sent'));
    const run = env.enqueue('Work', { deadlineAt: env.clock.now() + DEFERRED_RETRY_AFTER_MS / 2 });

    expect(await env.runOnce(env.worker())).toBe('yielded');

    const after = env.run(run.id);
    expect(after.status).toBe('FAILED');
    expect(after.error?.code).toBe('rate_limited');
    expect(env.ofType(run.id, 'run.status').some((event) => event.to === 'QUEUED')).toBe(false);
    expect(env.gateway.streams).toHaveLength(1);
  });

  it('fails the step with rate_limited instead of requeueing a deferral beyond the attempt limit', async () => {
    const env = await makeEnv({ maxAttempts: 2, maxTotalAttempts: 2 });
    env.gateway.script.push(deferredStep(), deferredStep(), textStep('never sent'));
    const run = env.enqueue('Work');

    expect(await env.runOnce(env.worker())).toBe('yielded');
    const requeued = env.run(run.id);
    expect(requeued.status).toBe('QUEUED');
    env.clock.set(requeued.availableAt);
    expect(await env.runOnce(env.worker('worker-2'))).toBe('yielded');

    const after = env.run(run.id);
    expect(after.status).toBe('FAILED');
    expect(after.error?.code).toBe('rate_limited');
    expect(env.gateway.streams).toHaveLength(2);
  });

  it('dead-letters the run as FAILED once the store attempt limit is exhausted by requeued hop failures', async () => {
    const env = await makeEnv({ maxAttempts: 3, maxTotalAttempts: 3 });
    env.gateway.script.push(thrownStep(), thrownStep(), thrownStep(), textStep('never sent'));
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
    expect(final.error?.message).toBe(`run ${run.id} exceeded 3 total attempts; the last attempt failed with: gateway connection reset`);
    expect(env.gateway.streams).toHaveLength(3);
    expect(new Set(env.gateway.streams.map((stream) => stream.idempotencyKey))).toEqual(new Set([modelKey(run.id, 1, 1)]));
    expect(env.gateway.script).toHaveLength(1);
  });
});
