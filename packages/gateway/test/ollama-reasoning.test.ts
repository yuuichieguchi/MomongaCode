import { describe, expect, it } from 'vitest';
import type { AdapterInputItem } from '@momonga/protocol';
import { expectSpecValid, ofType, terminalOf } from './cc-support.ts';
import { chunkLine, collectOllama, doneLine, makeOllamaAdapter, startFakeOllama } from './ollama-support.ts';

const THINKING = 'The user wants a.txt read.';

const readTool = {
  type: 'function' as const,
  name: 'Read',
  description: 'Read a file',
  parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
};

const thinkingThenCall = {
  kind: 'ndjson' as const,
  lines: [
    chunkLine({ thinking: 'The user wants ' }),
    chunkLine({ thinking: 'a.txt read.' }),
    chunkLine({ content: 'Reading.' }),
    chunkLine({ tool_calls: [{ id: 'call_t1', function: { index: 0, name: 'Read', arguments: { file_path: 'a.txt' } } }] }),
    doneLine(),
  ],
};

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
  });

  it('sends the reasoning item back as thinking on the assistant message', async () => {
    const fake = await startFakeOllama({ chat: [thinkingThenCall, { kind: 'ndjson', lines: [chunkLine({ content: 'done' }), doneLine()] }] });
    const adapter = makeOllamaAdapter(fake);
    const first = await collectOllama(adapter, { model: 'devstral-small-2', input: [user], tools: [readTool] });
    const output = terminalOf(first.events).response.output as AdapterInputItem[];

    await collectOllama(adapter, {
      model: 'devstral-small-2',
      tools: [readTool],
      input: [user, ...output, { type: 'function_call_output', call_id: 'call_t1', output: 'alpha' }],
    });

    const messages: any[] = fake.chatBodies().at(-1).messages;
    const assistants = messages.filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ thinking: THINKING, content: 'Reading.' });
    expect(assistants[0].tool_calls[0].function).toEqual({ name: 'Read', arguments: { file_path: 'a.txt' } });
    expect(messages.at(-1)).toMatchObject({ role: 'tool', tool_name: 'Read', content: 'alpha' });
  });
});
