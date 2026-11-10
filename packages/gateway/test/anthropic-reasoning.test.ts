import { describe, expect, it } from 'vitest';
import {
  anthropicBlockDelta,
  anthropicBlockStart,
  anthropicBlockStop,
  anthropicMessageEnd,
  anthropicMessageStart,
  anthropicStream,
  anthropicTextBlock,
  anthropicTextReply,
  anthropicToolUseBlock,
} from '@momonga/testkit';
import { postJson, readSse, userInput } from './gateway-helpers.ts';
import { readFileTool, startAnthropicGateway, streamResponse, terminalOf, typesOf } from './upstream-gateway-support.ts';

const THINKING = 'Plan: read a.txt first.';
const SIGNATURE = 'opaque-signature-of-the-thinking-block';

const thinkingThenToolUse = () =>
  anthropicStream([
    anthropicMessageStart(),
    anthropicBlockStart(0, { type: 'thinking', thinking: '' }),
    anthropicBlockDelta(0, { type: 'thinking_delta', thinking: 'Plan: read ' }),
    anthropicBlockDelta(0, { type: 'thinking_delta', thinking: 'a.txt first.' }),
    anthropicBlockDelta(0, { type: 'signature_delta', signature: SIGNATURE }),
    anthropicBlockStop(0),
    ...anthropicTextBlock(1, ['Reading it.']),
    ...anthropicToolUseBlock(2, 'toolu_01', 'read_file', ['{"path":', '"a.txt"}']),
    ...anthropicMessageEnd('tool_use'),
  ]);

describe('anthropic thinking blocks (R2b)', () => {
  it('turns a thinking block into a reasoning item with reasoning deltas, before the message and the call', async () => {
    const gateway = await startAnthropicGateway({ script: [thinkingThenToolUse()] });

    const frames = await streamResponse(gateway, { tools: [readFileTool] });

    const deltas = frames.filter((frame) => frame.data.type === 'response.reasoning.delta').map((frame) => frame.data.delta);
    expect(deltas.join('')).toBe(THINKING);
    expect(frames.filter((frame) => frame.data.type === 'response.reasoning.done').map((frame) => frame.data.text)).toEqual([THINKING]);
    const output: any[] = terminalOf(frames).response.output;
    expect(output.map((item) => item.type)).toEqual(['reasoning', 'message', 'function_call']);
    expect(typesOf(frames).indexOf('response.reasoning.delta')).toBeLessThan(typesOf(frames).indexOf('response.output_text.delta'));
  });

  it('sends the reasoning item back as the signed thinking block, unchanged', async () => {
    const gateway = await startAnthropicGateway({ script: [thinkingThenToolUse(), anthropicTextReply(['done'])] });
    const first = await streamResponse(gateway, { tools: [readFileTool], input: userInput('read a.txt') });
    const output: any[] = terminalOf(first).response.output;

    await readSse(
      await postJson(gateway.client, '/v1/responses', {
        model: 'scripted/upstream-model',
        stream: true,
        tools: [readFileTool],
        input: [...userInput('read a.txt'), ...output, { type: 'function_call_output', call_id: 'toolu_01', output: 'alpha' }],
      }),
    );

    const sent: any = gateway.fake.requests.filter((request) => request.path === '/v1/messages').at(-1)?.body;
    const assistant = sent.messages.find((message: any) => message.role === 'assistant');
    expect(assistant.content[0]).toEqual({ type: 'thinking', thinking: THINKING, signature: SIGNATURE });
    expect(assistant.content.map((block: any) => block.type)).toEqual(['thinking', 'text', 'tool_use']);
  });
});
