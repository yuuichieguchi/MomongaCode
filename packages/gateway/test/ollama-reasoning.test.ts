import { describe, expect, it } from 'vitest';
import type { AdapterInputItem } from '@momonga/protocol';
import { expectSpecValid, ofType, terminalOf } from './cc-support.ts';
import { QWEN_NATIVE_THINKING, chunkLine, collectOllama, doneLine, fixtureLines, makeOllamaAdapter, startFakeOllama } from './ollama-support.ts';

const recorded = fixtureLines(QWEN_NATIVE_THINKING).map((line) => JSON.parse(line).message);
const THINKING: string = recorded.map((message) => message.thinking ?? '').join('');
const TEXT: string = recorded.map((message) => message.content ?? '').join('');
const CALL = recorded.flatMap((message) => message.tool_calls ?? [])[0];

const readTool = {
  type: 'function' as const,
  name: 'Read',
  description: 'Read a file',
  parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
};

const thinkingThenCall = { kind: 'ndjson' as const, lines: fixtureLines(QWEN_NATIVE_THINKING) };

const user = { type: 'message' as const, role: 'user' as const, content: 'read a.txt' };

describe('ollama thinking (R2b)', () => {
  it('turns message.thinking into a reasoning item ahead of the message and the call', async () => {
    const fake = await startFakeOllama({ chat: [thinkingThenCall] });
    const { events, error } = await collectOllama(makeOllamaAdapter(fake), { model: 'devstral-small-2', input: [user], tools: [readTool] });
    expect(error).toBeUndefined();
    expect(expectSpecValid(events)).toEqual([]);
    expect(
      ofType(events, 'response.reasoning.delta')
        .map((event) => event.delta)
        .join(''),
    ).toBe(THINKING);
    expect(terminalOf(events).response.output.map((item: { type: string }) => item.type)).toEqual(['reasoning', 'message', 'function_call']);
    expect(THINKING.length).toBeGreaterThan(0);
    expect(terminalOf(events).response.output[2]).toMatchObject({ call_id: CALL.id, name: CALL.function.name });
  });

  it('sends the reasoning item back as thinking on the assistant message', async () => {
    const fake = await startFakeOllama({ chat: [thinkingThenCall, { kind: 'ndjson', lines: [chunkLine({ content: 'done' }), doneLine()] }] });
    const adapter = makeOllamaAdapter(fake);
    const first = await collectOllama(adapter, { model: 'devstral-small-2', input: [user], tools: [readTool] });
    const output = terminalOf(first.events).response.output as AdapterInputItem[];

    await collectOllama(adapter, {
      model: 'devstral-small-2',
      tools: [readTool],
      input: [user, ...output, { type: 'function_call_output', call_id: CALL.id, output: 'alpha' }],
    });

    const messages: any[] = fake.chatBodies().at(-1).messages;
    const assistants = messages.filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ thinking: THINKING, content: TEXT });
    expect(assistants[0].tool_calls[0].function).toEqual({ name: CALL.function.name, arguments: CALL.function.arguments });
    expect(messages.at(-1)).toMatchObject({ role: 'tool', tool_name: 'Read', content: 'alpha' });
  });
});
