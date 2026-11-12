import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@momonga/protocol';
import { GatewayRequestError } from '@momonga/runtime';
import type { GatewayPort } from '@momonga/runtime';
import { responseResource } from '@momonga/testkit';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { MODEL_ID, textStep } from './scripts.ts';

const MESSAGE_ID = 'msg_withdrawn';
const THOUGHT_ID = 'rs_withdrawn';

const interruptedStream = (): StreamEvent[] => [
  { type: 'response.created', sequence_number: 0, response: responseResource({ id: 'resp_withdrawn', model: MODEL_ID, status: 'in_progress' }) },
  { type: 'response.reasoning_summary_text.delta', sequence_number: 1, item_id: THOUGHT_ID, output_index: 0, summary_index: 0, delta: 'weighing' } as StreamEvent,
  { type: 'response.output_item.added', sequence_number: 2, output_index: 1, item: { type: 'message', id: MESSAGE_ID, status: 'in_progress', role: 'assistant', content: [] } },
  { type: 'response.output_text.delta', sequence_number: 3, item_id: MESSAGE_ID, output_index: 1, content_index: 0, delta: 'Half an ans' },
];

const interruptingGateway = (env: Env): GatewayPort => ({
  ...env.gateway,
  stream: () =>
    (async function* () {
      yield* interruptedStream();
      throw new GatewayRequestError({ status: 0, type: 'transport', code: 'stream_interrupted', message: 'the gateway stream was interrupted' });
    })(),
});

describe('a model request sent again after text was streamed', () => {
  it('writes the restart with the ids of the thought and text entries it withdraws, before the second stream', async () => {
    const env = await makeEnv();
    const run = await env.enqueue('Talk');
    await env.runOnce(env.worker('worker-1', { gateway: interruptingGateway(env) }));
    expect(env.run(run.id).status).toBe('QUEUED');

    env.gateway.script.push(textStep('The whole answer.'));
    env.clock.set(env.run(run.id).availableAt);
    await env.runOnce(env.worker('worker-2'));

    expect(env.run(run.id).status).toBe('COMPLETED');
    const restarts = env.ofType(run.id, 'model.stream.restarted');
    expect(restarts).toHaveLength(1);
    expect([...(restarts[0]?.itemIds ?? [])].sort()).toEqual([MESSAGE_ID, THOUGHT_ID].sort());
    const restartSeq = restarts[0]?.seq ?? 0;
    expect(env.ofType(run.id, 'agent.message.delta').filter((event) => event.seq > restartSeq).every((event) => event.itemId !== MESSAGE_ID)).toBe(true);
    expect(env.fold(run.id).streaming).toBeUndefined();
  });
});
