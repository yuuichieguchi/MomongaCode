import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@momonga/protocol';
import { makeEnv } from './harness.ts';
import { textStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';

const answeredBy = (step: ScriptStep, extension: Record<string, unknown>): ScriptStep => ({
  ...step,
  events: step.events.map(
    (event): StreamEvent =>
      event.type === 'response.completed' ? { ...event, response: { ...event.response, momonga: { model: 'fm', usageSource: 'reported', ...extension } as never } } : event,
  ),
});

describe('a refused billing change in the fallback notice', () => {
  it('is stored as the refusal alone, with no surface remedy', async () => {
    const env = await makeEnv();
    env.gateway.script.push(
      answeredBy(textStep('Done.', { usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }), {
        target: 'secondary',
        attempts: 2,
        fallbackFrom: ['primary'],
        fallbackCauses: [
          { target: 'primary', code: 'provider_unavailable', message: 'the upstream is unreachable' },
          { target: 'metered', name: 'metered', reason: 'billing_change_refused', fromBilling: 'plan', toBilling: 'metered' },
        ],
      }),
    );
    const run = await env.enqueue('Work');

    await env.runOnce(env.worker());

    const notice = env.ofType(run.id, 'notice').find((event) => event.code === 'fallback_target');
    expect(notice?.message).toBe(
      'The model call was answered by the fallback model secondary because primary failed (provider_unavailable: the upstream is unreachable). Did not fall back to metered: billing from plan to metered is not allowed.',
    );
  });

  it('names no command for a rejected plan credential either: each surface adds its own', async () => {
    const env = await makeEnv();
    env.gateway.script.push(
      answeredBy(textStep('Done.', { usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }), {
        target: 'secondary',
        attempts: 2,
        fallbackFrom: ['primary'],
        fallbackCauses: [{ target: 'primary', code: 'plan_credential_rejected', message: 'the plan credential was rejected' }],
      }),
    );
    const run = await env.enqueue('Work');

    await env.runOnce(env.worker());

    const message = env.ofType(run.id, 'notice').find((event) => event.code === 'fallback_target')?.message ?? '';
    expect(message).toContain('primary failed (plan_credential_rejected: the plan credential was rejected)');
    expect(message).not.toMatch(/\/login|\/models|auth login|models billing|momonga /);
  });
});
