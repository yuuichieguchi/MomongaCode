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

describe('a model call answered by a target other than the first of its model', () => {
  it('tells the person which target failed and why', async () => {
    const env = await makeEnv();
    env.gateway.script.push(
      answeredBy(textStep('Done.', { usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }), {
        target: 'secondary',
        attempts: 2,
        fallbackFrom: ['primary'],
        fallbackCauses: [{ target: 'primary', code: 'provider_unavailable', message: 'the chat-completions upstream is unreachable' }],
      }),
    );
    const run = await env.enqueue('Work');

    await env.runOnce(env.worker());

    const notices = env.ofType(run.id, 'notice');
    expect(notices).toContainEqual(
      expect.objectContaining({
        level: 'warning',
        code: 'fallback_target',
        message: 'The model call was answered by the fallback target secondary because primary failed (provider_unavailable: the chat-completions upstream is unreachable).',
      }),
    );
  });

  it('says nothing when the first target answered', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Done.'));
    const run = await env.enqueue('Work');

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'notice').filter((event) => event.code === 'fallback_target')).toEqual([]);
  });
});
