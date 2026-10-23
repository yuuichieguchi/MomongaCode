import { describe, expect, it } from 'vitest';
import { makeEnv, modelKey } from './harness.ts';
import { failedStep, textStep, thrownStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';

const FAILURES: [string, () => ScriptStep][] = [
  ['a response.failed server error', () => failedStep('upstream_unavailable', 'server_error')],
  ['a thrown stream error', () => thrownStep()],
];

describe('worker gateway failures', () => {
  it.each(FAILURES)('requeues with backoff after %s and re-sends the same key and body', async (_label, failure) => {
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

  it('dead-letters the run as FAILED once the store attempt limit is exhausted', async () => {
    const env = await makeEnv({ maxAttempts: 3, maxTotalAttempts: 3 });
    env.gateway.script.push(failedStep('upstream_unavailable'), failedStep('upstream_unavailable'), failedStep('upstream_unavailable'), textStep('never sent'));
    const run = env.enqueue('Work');

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(await env.runOnce(env.worker(`worker-${attempt}`))).toBe('yielded');
      const current = env.run(run.id);
      expect(current.status).toBe('QUEUED');
      env.clock.set(Math.max(env.clock.now(), current.availableAt));
    }

    expect(await env.runOnce(env.worker('worker-final'))).toBe('idle');
    const final = env.run(run.id);
    expect(final.status).toBe('FAILED');
    expect(final.deadLetter).toBe(true);
    expect(final.error?.code).toBe('max_total_attempts');
    expect(env.gateway.streams).toHaveLength(3);
    expect(new Set(env.gateway.streams.map((stream) => stream.idempotencyKey))).toEqual(new Set([modelKey(run.id, 1, 1)]));
    expect(env.gateway.script).toHaveLength(1);
  });
});
