import { describe, expect, it } from 'vitest';
import { createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import { postJson, readJson, readSse, startGateway, userInput } from './gateway-helpers.ts';
import { functionCallEvents } from './gateway-support.ts';

const callIdsOf = (input: unknown[]): string[] =>
  (input as Array<{ type: string; call_id?: string }>).filter((item) => item.call_id !== undefined).map((item) => item.call_id as string);

describe('function call ids', () => {
  it('rewrites provider call ids per response and keeps chained history unambiguous', async () => {
    const primary = createScriptedAdapter({
      calls: [
        { events: functionCallEvents('call_0', 'read_file', '{"path":"a"}') },
        { events: functionCallEvents('call_0', 'read_file', '{"path":"b"}') },
        { events: textResponseEvents({ model: 'm', chunks: ['final'] }) },
      ],
    });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    const first = await readJson(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('q1'), store: true }));
    const firstCall = first.body.output[0];
    expect(firstCall.call_id).toMatch(/^call_/);
    expect(firstCall.call_id).not.toBe('call_0');

    const second = await readJson(
      await postJson(client, '/v1/responses', {
        model: 'scripted/scripted-primary',
        store: true,
        previous_response_id: first.body.id,
        input: [{ type: 'function_call_output', call_id: firstCall.call_id, output: 'A' }],
      }),
    );
    const secondCall = second.body.output[0];
    expect(secondCall.call_id).not.toBe(firstCall.call_id);

    await readJson(
      await postJson(client, '/v1/responses', {
        model: 'scripted/scripted-primary',
        previous_response_id: second.body.id,
        input: [{ type: 'function_call_output', call_id: secondCall.call_id, output: 'B' }],
      }),
    );
    const sent = primary.calls[2]?.request.input as unknown[];
    expect(callIdsOf(sent)).toEqual([firstCall.call_id, firstCall.call_id, secondCall.call_id, secondCall.call_id]);
    expect(callIdsOf(sent)).not.toContain('call_0');
  });

  it('uses the same rewritten id in item events and the terminal output of a stream', async () => {
    const primary = createScriptedAdapter({ calls: [{ events: functionCallEvents('call_0', 'read_file', '{}') }] });
    const { client } = await startGateway({ adapters: { 'scripted/scripted-primary': primary } });
    const frames = await readSse(await postJson(client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('q'), stream: true }));
    const added = frames.find((frame) => frame.data.type === 'response.output_item.added')?.data.item.call_id;
    const done = frames.find((frame) => frame.data.type === 'response.output_item.done')?.data.item.call_id;
    const terminal = frames.at(-1)?.data.response.output[0].call_id;
    expect(added).toMatch(/^call_/);
    expect(added).not.toBe('call_0');
    expect(done).toBe(added);
    expect(terminal).toBe(added);
  });
});
