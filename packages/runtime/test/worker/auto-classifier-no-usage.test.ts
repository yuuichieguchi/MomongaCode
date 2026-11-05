import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@momonga/protocol';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';

const withoutUsage = (step: ScriptStep): ScriptStep => ({
  ...step,
  events: step.events.map((event): StreamEvent =>
    event.type === 'response.completed' ? ({ ...event, response: { ...event.response, usage: null } } as unknown as StreamEvent) : event,
  ),
});

describe('auto mode classifier reply without usage', () => {
  it('requeues the run, because the gateway delivered the reply and could not have retried it', async () => {
    const env = await makeEnv({ mode: 'auto' });
    env.settings.classifierAlias = 'guard';
    env.gateway.capabilitiesByAlias['guard'] = capabilitiesFor(env.gateway.capabilitiesValue.contextWindow, { structuredOutput: 'json_schema' });
    const reply = JSON.stringify({ verdict: 'safe', confidence: 'high', rationale: 'ok' });
    env.gateway.script.push(
      callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: `${env.project}/out.txt`, content: 'x' } }]),
      withoutUsage(textStep(reply, { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } })),
      textStep('never sent'),
    );
    const run = env.enqueue('Write out.txt');

    expect(await env.runOnce(env.worker())).toBe('yielded');

    expect(env.run(run.id).status).toBe('QUEUED');
  });
});
