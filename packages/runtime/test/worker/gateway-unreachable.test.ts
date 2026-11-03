import { describe, expect, it } from 'vitest';
import { GatewayRequestError } from '../../src/gateway-client.ts';
import { dispositionOf } from '../../src/worker/gateway-policy.ts';
import { makeEnv } from './harness.ts';
import type { ScriptStep } from './fake-gateway.ts';

const CAUSE = 'every candidate target is unavailable because its circuit breaker is open (dead: the chat-completions upstream is unreachable)';

const unreachable = (): GatewayRequestError =>
  new GatewayRequestError({ status: 503, type: 'server_error', code: 'all_targets_unreachable', message: CAUSE });

const throwing = (error: Error): ScriptStep => ({ events: [], error });

describe('a gateway whose every target is unreachable', () => {
  it('fails the run with the code and the cause instead of requeueing it', () => {
    expect(dispositionOf(unreachable(), 0)).toEqual({ kind: 'fail', code: 'all_targets_unreachable', message: CAUSE });
  });

  it('still requeues a gateway whose breakers are open for another reason', () => {
    const open = new GatewayRequestError({ status: 503, type: 'server_error', code: 'all_targets_unavailable', message: 'every candidate target is unavailable' });
    expect(dispositionOf(open, 0)).toMatchObject({ kind: 'requeue' });
  });

  it('still requeues a single upstream failure that the gateway reports as unreachable', () => {
    const refused = new GatewayRequestError({ status: 502, type: 'server_error', code: 'provider_unavailable', message: 'the chat-completions upstream is unreachable' });
    expect(dispositionOf(refused, 0)).toMatchObject({ kind: 'requeue' });
  });

  it('ends the run FAILED with the cause in its error', async () => {
    const env = await makeEnv();
    env.gateway.script.push(throwing(unreachable()));
    const run = env.enqueue('Work');

    await env.runOnce(env.worker());

    const final = env.run(run.id);
    expect(final.status).toBe('FAILED');
    expect(final.error).toEqual({ code: 'all_targets_unreachable', message: CAUSE });
  });
});
