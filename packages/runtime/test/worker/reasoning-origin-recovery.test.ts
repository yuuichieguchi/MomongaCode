import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { makeEnv } from './harness.ts';
import { functionCallItem, requestedOffering, textStep } from './scripts.ts';

const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
const SIGNED_MARKER = 'eyJ2IjoxLCJhZGFwdGVyIjoiYW50aHJvcGljIn0.gateway-signed-marker';
const REASONING = {
  type: 'reasoning',
  id: 'rs_origin_1',
  summary: [],
  content: [{ type: 'reasoning_text', text: 'plan the echo' }],
  encrypted_content: SIGNED_MARKER,
};

const respondedWithReasoning: RunEventPayload = {
  type: 'model.responded',
  step: 1,
  attempt: 1,
  response: { status: 'completed', output: [REASONING, functionCallItem({ callId: 'call_o_1', name: 'Echo', args: { value: 'x' } })], usage: USAGE },
} as unknown as RunEventPayload;

describe('the signed reasoning marker in encrypted_content survives the journal and a recovery replay (item 5)', () => {
  it('keeps the marker in the recorded response and sends it in the next request after a crash', async () => {
    const env = await makeEnv();
    const run = await env.enqueue('Echo x');
    await env.seed(
      run.id,
      [
        requestedOffering(1, ['Echo']),
        respondedWithReasoning,
        { type: 'tool.call', callId: 'call_o_1', providerCallId: 'call_o_1', name: 'Echo', kind: 'read', title: 'Echo x', rawInput: { value: 'x' } },
        { type: 'tool.completed', callId: 'call_o_1', status: 'completed', output: 'echo:x' },
      ],
      'crash',
    );
    env.gateway.script.push(textStep('Done.'));

    await env.runOnce(env.worker());

    const recorded: any[] = (env.ofType(run.id, 'model.responded')[0] as any).response.output;
    expect(recorded[0]).toEqual(REASONING);
    const sent = env.gateway.streams[0]?.body.input as any[];
    expect(sent.filter((item) => item.type === 'reasoning')).toEqual([REASONING]);
  });
});
