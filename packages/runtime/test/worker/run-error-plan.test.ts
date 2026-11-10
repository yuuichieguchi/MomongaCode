import { describe, expect, it } from 'vitest';
import { GatewayRequestError } from '../../src/gateway-client.ts';
import { makeEnv } from './harness.ts';
import { failedStep, textStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';

type Fields = ConstructorParameters<typeof GatewayRequestError>[0];

const PLAN = { profile: 'chatgpt', account: 'work' };

const throwing = (fields: Fields & { plan?: typeof PLAN }): ScriptStep => ({ events: [], error: new GatewayRequestError(fields as Fields) });

describe('a run ended by a plan target failure keeps the plan account in its error', () => {
  it('a thrown usage limit with plan stops the run with the plan in its error', async () => {
    const env = await makeEnv();
    env.gateway.script.push(throwing({ status: 429, type: 'too_many_requests', code: 'plan_usage_limit', message: 'Manage usage.', plan: PLAN }), textStep('never sent'));
    const run = env.enqueue('Work', { limits: { maxSteps: 5 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'usage_limit', error: { code: 'plan_usage_limit', message: 'Manage usage.', plan: PLAN } });
  });

  it('a thrown sign_in_required with plan fails the run with the plan in its error', async () => {
    const env = await makeEnv();
    env.gateway.script.push(throwing({ status: 401, type: 'invalid_request', code: 'sign_in_required', message: 'The ChatGPT sign-in expired.', plan: PLAN }), textStep('never sent'));
    const run = env.enqueue('Work', { limits: { maxSteps: 5 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('FAILED');
    expect(env.run(run.id).error).toEqual({ code: 'sign_in_required', message: 'The ChatGPT sign-in expired.', plan: PLAN });
  });

  it('a response.failed with a usage code and plan stops the run like the thrown form, with no wrap-up call', async () => {
    const env = await makeEnv();
    env.gateway.script.push(failedStep('plan_usage_limit', 'too_many_requests', PLAN), textStep('never sent'));
    const run = env.enqueue('Work', { limits: { maxSteps: 5 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id)).toMatchObject({ status: 'STOPPED', stopReason: 'usage_limit' });
    expect(env.run(run.id).error).toEqual({ code: 'plan_usage_limit', message: 'upstream failed with plan_usage_limit', plan: PLAN });
    expect(env.gateway.streams).toHaveLength(1);
  });

  it('a response.failed with plan_not_eligible and plan fails the run with the plan in its error', async () => {
    const env = await makeEnv();
    env.gateway.script.push(failedStep('plan_not_eligible', 'server_error', PLAN), textStep('never sent'));
    const run = env.enqueue('Work', { limits: { maxSteps: 5 } });

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('FAILED');
    expect(env.run(run.id).error).toEqual({ code: 'plan_not_eligible', message: 'upstream failed with plan_not_eligible', plan: PLAN });
  });

  it('a response.failed without plan fails the run with no plan key', async () => {
    const env = await makeEnv();
    env.gateway.script.push(failedStep('upstream_unavailable'), textStep('never sent'));
    const run = env.enqueue('Work', { limits: { maxSteps: 5 } });

    await env.runOnce(env.worker());

    const ended = env.run(run.id);
    expect(ended.status).toBe('FAILED');
    expect(ended.error).toMatchObject({ code: 'upstream_unavailable' });
    expect('plan' in (ended.error ?? {})).toBe(false);
  });

  it('a run that exceeds maxTotalAttempts after plan failures ends with max_total_attempts and no plan key', async () => {
    const env = await makeEnv({ maxAttempts: 3, maxTotalAttempts: 3 });
    const planFailure = (): ScriptStep => throwing({ status: 502, type: 'server_error', code: 'provider_unavailable', message: 'the plan upstream is unreachable', plan: PLAN });
    env.gateway.script.push(planFailure(), planFailure(), planFailure());
    const run = env.enqueue('Work');

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      expect(await env.runOnce(env.worker(`worker-${attempt}`))).toBe('yielded');
      const current = env.run(run.id);
      expect(current.status).toBe('QUEUED');
      env.clock.set(Math.max(env.clock.now(), current.availableAt));
    }
    expect(await env.runOnce(env.worker('worker-3'))).toBe('yielded');

    const ended = env.run(run.id);
    expect(ended.status).toBe('FAILED');
    expect(ended.error).toMatchObject({ code: 'max_total_attempts' });
    expect('plan' in (ended.error ?? {})).toBe(false);
  });
});
