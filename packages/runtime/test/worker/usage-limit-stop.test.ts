import { describe, expect, it } from 'vitest';
import { GatewayRequestError } from '../../src/gateway-client.ts';
import { dispositionOf } from '../../src/worker/gateway-policy.ts';
import { makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const gatewayError = (status: number, type: 'too_many_requests' | 'invalid_request', code: string, extra: { retryAfterMs?: number; deferred?: boolean } = {}): GatewayRequestError =>
  new GatewayRequestError({ status, type, code, message: `${code} from the gateway`, ...extra });

describe('a usage-limit code stops the run instead of failing or requeueing it (P3c, M7, I-U1)', () => {
  it.each(['plan_usage_limit', 'plan_workspace_usage_limit', 'plan_usage_paused'])('disposes %s as a stop with reason usage_limit, keeping its code and message', (code) => {
    expect(dispositionOf(gatewayError(429, 'too_many_requests', code, { retryAfterMs: 30_000 }), 0)).toEqual({
      kind: 'stop',
      reason: 'usage_limit',
      code,
      message: `${code} from the gateway`,
    });
  });

  it.each(['plan_usage_limit', 'plan_workspace_usage_limit', 'plan_usage_paused'])('stops on %s even when the gateway marked the answer deferred by a long Retry-After', (code) => {
    expect(dispositionOf(gatewayError(429, 'too_many_requests', code, { retryAfterMs: 3_600_000, deferred: true }), 0)).toMatchObject({ kind: 'stop', reason: 'usage_limit' });
  });

  it('keeps sign_in_required and plan_not_eligible as failures', () => {
    expect(dispositionOf(gatewayError(401, 'invalid_request', 'sign_in_required'), 0)).toMatchObject({ kind: 'fail', code: 'sign_in_required' });
    expect(dispositionOf(gatewayError(400, 'invalid_request', 'plan_not_eligible'), 0)).toMatchObject({ kind: 'fail', code: 'plan_not_eligible' });
    expect(dispositionOf(gatewayError(429, 'too_many_requests', 'plan_usage_paused'), 0)).toMatchObject({ kind: 'stop' });
  });
});

describe('a usage answer ends the run STOPPED(usage_limit) in the worker (P3c, M7, I-U1)', () => {
  const USAGE = { status: 429, type: 'too_many_requests', code: 'plan_usage_limit', message: 'Usage limit reached Request id: req_1', retryAfterMs: 3_600_000, deferred: true } as const;

  it('stops a deferred usage answer at a normal step with no requeue and keeps the code in the run error', async () => {
    const env = await makeEnv();
    env.gateway.script.push({ events: [], error: new GatewayRequestError(USAGE) }, textStep('never sent'));
    const run = await env.enqueue('Work', { limits: { maxSteps: 5 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'usage_limit', error: { code: 'plan_usage_limit' } });
    expect(env.gateway.streams).toHaveLength(1);
    expect(await env.runOnce(env.worker('worker-2'))).toBe('idle');
    expect(env.gateway.streams).toHaveLength(1);
  });

  it('stops a quota answer to a wrap-up request the same way, with no further call', async () => {
    const env = await makeEnv();
    env.gateway.script.push(callsStep([{ callId: 'call_u_1', name: 'Echo', args: { value: 'x' } }]), { events: [], error: new GatewayRequestError(USAGE) }, textStep('never sent'));
    const run = await env.enqueue('Work', { limits: { maxSteps: 1 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'usage_limit' });
    expect(env.gateway.streams).toHaveLength(2);
    expect(await env.runOnce(env.worker('worker-2'))).toBe('idle');
    expect(env.gateway.streams).toHaveLength(2);
  });
});
