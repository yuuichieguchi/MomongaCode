import { describe, expect, it } from 'vitest';
import { GatewayRequestError } from '../../src/gateway-client.ts';
import { dispositionOf } from '../../src/worker/gateway-policy.ts';
import { makeEnv } from './harness.ts';
import type { ScriptStep } from './fake-gateway.ts';

const CAUSE = 'the chat-completions upstream is unreachable';

const unreachable = (): GatewayRequestError => new GatewayRequestError({ status: 502, type: 'server_error', code: 'provider_unavailable', message: CAUSE });

const throwing = (error: Error): ScriptStep => ({ events: [], error });

describe('a gateway whose target stayed unreachable for its whole retry budget', () => {
  it('fails the run with the code and the cause instead of requeueing it', () => {
    expect(dispositionOf(unreachable(), 0)).toEqual({ kind: 'fail', code: 'provider_unavailable', message: CAUSE });
  });

  it('requeues a gateway that itself could not be reached, proven not sent', () => {
    const refused = new GatewayRequestError({ status: 0, type: 'transport', code: 'gateway_unavailable', message: 'the gateway socket refused the connection', provenNotSent: true });
    expect(dispositionOf(refused, 0)).toMatchObject({ kind: 'requeue', refund: true });
  });

  it('ends the run FAILED with the cause in its error on the first claim', async () => {
    const env = await makeEnv();
    env.gateway.script.push(throwing(unreachable()));
    const run = env.enqueue('Work');

    await env.runOnce(env.worker());

    const final = env.run(run.id);
    expect(final.status).toBe('FAILED');
    expect(final.error).toEqual({ code: 'provider_unavailable', message: CAUSE });
    expect(env.gateway.streams).toHaveLength(1);
  });
});
