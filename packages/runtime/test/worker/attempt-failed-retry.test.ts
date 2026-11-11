import { describe, expect, it } from 'vitest';
import { GatewayRequestError } from '../../src/gateway-client.ts';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { textStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';

type Fields = ConstructorParameters<typeof GatewayRequestError>[0];

const throwing = (fields: Fields): ScriptStep => ({ events: [], error: new GatewayRequestError(fields) });

const ATTEMPT_LIMIT = 20;

const WAITS: [string, () => ScriptStep, string][] = [
  ['a lost gateway connection', () => throwing({ status: 0, type: 'transport', code: 'gateway_unavailable', message: 'the gateway connection was lost', provenNotSent: false }), 'gateway_unavailable'],
  ['an unreachable provider', () => throwing({ status: 502, type: 'server_error', code: 'provider_unavailable', message: 'the chat-completions upstream is unreachable' }), 'provider_unavailable'],
  [
    'a deferral beyond the gateway window',
    () => throwing({ status: 429, type: 'too_many_requests', code: 'rate_limited', message: 'wait', retryAfterMs: 90_000, deferred: true }),
    'rate_limited',
  ],
];

const failures = (env: Env, runId: string): Record<string, unknown>[] =>
  env.events(runId).filter((event) => event.type === 'attempt.failed') as unknown as Record<string, unknown>[];

describe('attempt.failed carries when the run is tried again, its attempt and the attempt limit (decision 67)', () => {
  it.each(WAITS)('after %s, retryAt is the availableAt the store wrote, and limit is maxTotalAttempts', async (_label, failure, code) => {
    const env = await makeEnv({ maxAttempts: 3, maxTotalAttempts: ATTEMPT_LIMIT });
    env.gateway.script.push(failure(), textStep('Recovered.'));
    const run = await env.enqueue('Work');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    const queued = env.run(run.id);
    expect(queued.status).toBe('QUEUED');
    expect(queued.availableAt).toBeGreaterThan(env.clock.now());
    expect(failures(env, run.id)).toEqual([expect.objectContaining({ type: 'attempt.failed', code, attempt: 1, limit: ATTEMPT_LIMIT, retryAt: queued.availableAt })]);
  });

  it('a deferral sets retryAt to the deferral instant, the failure time plus the wait the provider asked for', async () => {
    const env = await makeEnv({ maxAttempts: 3, maxTotalAttempts: ATTEMPT_LIMIT });
    const failedAt = env.clock.now();
    env.gateway.script.push(throwing({ status: 429, type: 'too_many_requests', code: 'rate_limited', message: 'wait', retryAfterMs: 90_000, deferred: true }), textStep('Recovered.'));
    const run = await env.enqueue('Work');

    await env.runOnce(env.worker());

    expect(failures(env, run.id)).toEqual([expect.objectContaining({ retryAt: failedAt + 90_000 })]);
    expect(env.run(run.id).availableAt).toBe(failedAt + 90_000);
  });

  it('the second failure carries the second attempt and the availableAt of its own requeue', async () => {
    const env = await makeEnv({ maxAttempts: 3, maxTotalAttempts: ATTEMPT_LIMIT });
    const lost = (): ScriptStep => throwing({ status: 502, type: 'server_error', code: 'provider_unavailable', message: 'the chat-completions upstream is unreachable' });
    env.gateway.script.push(lost(), lost(), textStep('Recovered.'));
    const run = await env.enqueue('Work');

    await env.runOnce(env.worker('worker-1'));
    const firstRetryAt = env.run(run.id).availableAt;
    env.clock.set(firstRetryAt);
    await env.runOnce(env.worker('worker-2'));
    const secondRetryAt = env.run(run.id).availableAt;

    expect(failures(env, run.id).map(({ attempt, limit, retryAt }) => ({ attempt, limit, retryAt }))).toEqual([
      { attempt: 1, limit: ATTEMPT_LIMIT, retryAt: firstRetryAt },
      { attempt: 2, limit: ATTEMPT_LIMIT, retryAt: secondRetryAt },
    ]);
  });
});
