import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@momonga/protocol';
import { GatewayRequestError } from '../../src/gateway-client.ts';
import { dispositionOf } from '../../src/worker/gateway-policy.ts';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import type { ScriptStep } from './fake-gateway.ts';

const CAUSE = 'the chat-completions upstream is unreachable';

const unreachable = (): GatewayRequestError => new GatewayRequestError({ status: 502, type: 'server_error', code: 'provider_unavailable', message: CAUSE });

const throwing = (error: Error): ScriptStep => ({ events: [], error });

const failureRecords = (env: Env, runId: string): RunEvent[] => env.events(runId).filter((event) => event.type === 'attempt.failed');

const precedingEachRequeue = (env: Env, runId: string): string[] => {
  const events = env.events(runId);
  return events.flatMap((event, index) => (event.type === 'run.status' && event.from === 'RUNNING' && event.to === 'QUEUED' ? [events[index - 1]?.type ?? 'none'] : []));
};

describe('a provider that stayed unreachable for the gateway retry window is a transient failure (decision 64)', () => {
  it('requeues it without a refund, the same disposition as a transport failure', () => {
    expect(dispositionOf(unreachable(), 0)).toEqual({ kind: 'requeue', refund: false, retryAfterMs: 0, interrupted: false });
  });

  it('requeues a gateway that itself could not be reached, proven not sent', () => {
    const refused = new GatewayRequestError({ status: 0, type: 'transport', code: 'gateway_unavailable', message: 'the gateway socket refused the connection', provenNotSent: true });
    expect(dispositionOf(refused, 0)).toMatchObject({ kind: 'requeue', refund: true });
  });

  it('records attempt.failed with provider_unavailable and yields the run to QUEUED on the first claim', async () => {
    const env = await makeEnv();
    env.gateway.script.push(throwing(unreachable()));
    const run = env.enqueue('Work');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).status).toBe('QUEUED');
    expect(env.run(run.id).attempts).toBe(1);
    expect(failureRecords(env, run.id)).toEqual([expect.objectContaining({ type: 'attempt.failed', attempt: 1, code: 'provider_unavailable' })]);
    expect(precedingEachRequeue(env, run.id)).toEqual(['attempt.failed']);
    expect(env.gateway.streams).toHaveLength(1);
  });

  it('ends the run FAILED under the attempt limit rule, naming the last unreachable-provider failure, once the attempts are exhausted', async () => {
    const env = await makeEnv({ maxAttempts: 3, maxTotalAttempts: 3 });
    env.gateway.script.push(throwing(unreachable()), throwing(unreachable()), throwing(unreachable()));
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
    expect(final.error).toEqual({ code: 'max_total_attempts', message: `run ${run.id} exceeded 3 total attempts; the last attempt failed with: ${CAUSE}` });
    expect(env.gateway.streams).toHaveLength(3);
  });
});
