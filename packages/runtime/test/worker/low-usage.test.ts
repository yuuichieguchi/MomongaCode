import { describe, expect, it } from 'vitest';
import { usageOf } from '@momonga/testkit';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

describe('worker with low reported usage', () => {
  it('completes a tool step whose usage reports far fewer prompt tokens than the estimate', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(8192, { maxOutputTokens: 1024 }) });
    env.gateway.script.push(
      callsStep([{ callId: 'call_low_1', name: 'Echo', args: { value: 'a' } }], usageOf(10, 5)),
      textStep('Done.'),
    );
    const run = env.enqueue('Echo something');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.gateway.streams).toHaveLength(2);
    const input = env.gateway.streams[1]?.body.input;
    if (!Array.isArray(input)) throw new Error('expected an input array');
    expect(input.filter((item) => item.type === 'function_call_output')).toEqual([
      expect.objectContaining({ call_id: 'call_low_1', output: 'echo:a' }),
    ]);
  });
});
