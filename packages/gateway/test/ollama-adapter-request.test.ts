import { describe, expect, it } from 'vitest';
import type { AdapterRequest } from '@momonga/protocol';
import { OLLAMA_CAPABILITIES, chunkLine, collectOllama, doneLine, makeOllamaAdapter, startFakeOllama } from './ollama-support.ts';

const textReply = () => ({ kind: 'ndjson' as const, lines: [chunkLine({ content: 'ok' }), doneLine()] });

const userText = (text: string) => ({ type: 'message' as const, role: 'user' as const, content: [{ type: 'input_text' as const, text }] });

const readFileTool = {
  type: 'function' as const,
  name: 'read_file',
  description: 'Read a file from the workspace',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
};

const sentBody = async (request: AdapterRequest, contextWindow = OLLAMA_CAPABILITIES.contextWindow): Promise<any> => {
  const fake = await startFakeOllama({ chat: [textReply()] });
  const adapter = makeOllamaAdapter(fake, { capabilities: async () => ({ ...OLLAMA_CAPABILITIES, contextWindow }) });
  const { error } = await collectOllama(adapter, request);
  expect(error).toBeUndefined();
  const bodies = fake.chatBodies();
  expect(bodies).toHaveLength(1);
  return bodies[0];
};

const rejection = async (request: AdapterRequest): Promise<{ error: any; chatRequests: number }> => {
  const fake = await startFakeOllama({ chat: [textReply()] });
  const { error } = await collectOllama(makeOllamaAdapter(fake), request);
  return { error, chatRequests: fake.chatBodies().length };
};

describe('ollama request: the native chat endpoint and the context size (I1)', () => {
  it('posts to /api/chat with num_ctx equal to the resolved contextWindow and num_predict equal to the output limit', async () => {
    const body = await sentBody({ model: 'devstral-small-2', instructions: 'be brief', input: [userText('hi')], max_output_tokens: 300 });
    expect(body.model).toBe('devstral-small-2');
    expect(body.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ]);
    expect(body.options).toMatchObject({ num_ctx: 12288, num_predict: 300 });
    expect(body.truncate).toBe(false);
  });

  it('follows the resolved contextWindow, not a constant', async () => {
    const small = await sentBody({ model: 'devstral-small-2', input: [userText('hi')], max_output_tokens: 300 }, 6144);
    const large = await sentBody({ model: 'devstral-small-2', input: [userText('hi')], max_output_tokens: 300 }, 32768);
    expect(small.options.num_ctx).toBe(6144);
    expect(large.options.num_ctx).toBe(32768);
  });

  it('sends the target output limit as num_predict when the request names none', async () => {
    const body = await sentBody({ model: 'devstral-small-2', input: [userText('hi')] });
    expect(body.options).toMatchObject({ num_ctx: 12288, num_predict: 2048 });
  });

  it('never sends keep_alive, so the server default unloading applies', async () => {
    const body = await sentBody({ model: 'devstral-small-2', input: [userText('hi')], max_output_tokens: 300 });
    expect('keep_alive' in body).toBe(false);
  });
});

describe('ollama request: history', () => {
  it('sends assistant tool calls with object arguments and tool results as role tool with tool_name', async () => {
    const body = await sentBody({
      model: 'devstral-small-2',
      tools: [readFileTool],
      input: [
        userText('read a.txt'),
        { type: 'function_call', call_id: 'call_q6m8xkax', name: 'read_file', arguments: '{"path":"a.txt"}' },
        { type: 'function_call_output', call_id: 'call_q6m8xkax', output: 'alpha' },
      ],
      max_output_tokens: 300,
    });
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]).toEqual({ role: 'user', content: 'read a.txt' });
    expect(body.messages[1].role).toBe('assistant');
    expect(body.messages[1].tool_calls).toHaveLength(1);
    expect(body.messages[1].tool_calls[0].function).toEqual({ name: 'read_file', arguments: { path: 'a.txt' } });
    expect(body.messages[2]).toMatchObject({ role: 'tool', tool_name: 'read_file', content: 'alpha' });
  });

  it('sends an assistant text message as an assistant message', async () => {
    const body = await sentBody({
      model: 'devstral-small-2',
      input: [userText('hi'), { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }, userText('again')],
      max_output_tokens: 300,
    });
    expect(body.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
    ]);
  });
});

describe('ollama request: tool_choice', () => {
  const withChoice = (tool_choice: AdapterRequest['tool_choice']): AdapterRequest => ({
    model: 'devstral-small-2',
    input: [userText('read a.txt')],
    tools: [readFileTool],
    ...(tool_choice === undefined ? {} : { tool_choice }),
    max_output_tokens: 300,
  });

  const expectedTool = {
    type: 'function',
    function: { name: 'read_file', description: 'Read a file from the workspace', parameters: readFileTool.parameters },
  };

  it('sends the tools when tool_choice is absent', async () => {
    expect((await sentBody(withChoice(undefined))).tools).toEqual([expectedTool]);
  });

  it('sends the tools when tool_choice is auto', async () => {
    expect((await sentBody(withChoice('auto'))).tools).toEqual([expectedTool]);
  });

  it('sends no tools when tool_choice is none', async () => {
    expect('tools' in (await sentBody(withChoice('none')))).toBe(false);
  });

  it('refuses tool_choice required with unsupported_tool_choice on the tool_choice parameter, without calling the server', async () => {
    const { error, chatRequests } = await rejection(withChoice('required'));
    expect(error).toMatchObject({ name: 'UnsupportedInputError', code: 'unsupported_tool_choice', param: 'tool_choice' });
    expect(chatRequests).toBe(0);
  });

  it('refuses a named tool_choice with unsupported_tool_choice on the tool_choice parameter, without calling the server', async () => {
    const { error, chatRequests } = await rejection(withChoice({ type: 'function', name: 'read_file' }));
    expect(error).toMatchObject({ name: 'UnsupportedInputError', code: 'unsupported_tool_choice', param: 'tool_choice' });
    expect(chatRequests).toBe(0);
  });
});

describe('ollama request: images', () => {
  it('sends a data: URL image as its base64 data in messages[].images', async () => {
    const body = await sentBody({
      model: 'devstral-small-2',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'what is this' },
            { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
          ],
        },
      ],
      max_output_tokens: 300,
    });
    expect(body.messages).toEqual([{ role: 'user', content: 'what is this', images: ['iVBORw0KGgo='] }]);
  });

  it('refuses an image given by an http URL as unsupported input, without calling the server', async () => {
    const { error, chatRequests } = await rejection({
      model: 'devstral-small-2',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/cat.png' }] }],
      max_output_tokens: 300,
    });
    expect(error).toMatchObject({ name: 'UnsupportedInputError' });
    expect(chatRequests).toBe(0);
  });
});

describe('ollama request: structured output and thinking', () => {
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };

  it('maps a JSON-schema text format to format with that schema', async () => {
    const body = await sentBody({
      model: 'devstral-small-2',
      input: [userText('answer in JSON')],
      text: { format: { type: 'json_schema', name: 'answer', schema, strict: true } },
      max_output_tokens: 300,
    });
    expect(body.format).toEqual(schema);
  });

  it('sends no format for a request without a text format', async () => {
    expect('format' in (await sentBody({ model: 'devstral-small-2', input: [userText('hi')], max_output_tokens: 300 }))).toBe(false);
  });

  it('sends no think without a reasoning setting', async () => {
    expect('think' in (await sentBody({ model: 'devstral-small-2', input: [userText('hi')], max_output_tokens: 300 }))).toBe(false);
  });

  for (const effort of ['minimal', 'low', 'high'] as const) {
    it(`sends no think true for reasoning effort ${effort} to a target without a reasoning capability`, async () => {
      expect((await sentBody({ model: 'devstral-small-2', input: [userText('hi')], max_output_tokens: 300, reasoning_effort: effort })).think).not.toBe(true);
    });
  }

  it('sends no think for reasoning effort none to a target without a reasoning capability', async () => {
    expect('think' in (await sentBody({ model: 'devstral-small-2', input: [userText('hi')], max_output_tokens: 300, reasoning_effort: 'none' }))).toBe(false);
  });

  const thinkSentWith = async (effort: NonNullable<AdapterRequest['reasoning_effort']>): Promise<unknown> => {
    const fake = await startFakeOllama({ chat: [textReply()] });
    const reasoning = { control: 'reasoning_effort', lowest: 'none' } as const;
    const adapter = makeOllamaAdapter(fake, { capabilities: async () => ({ ...OLLAMA_CAPABILITIES, reasoning }) });
    const { error } = await collectOllama(adapter, { model: 'devstral-small-2', input: [userText('hi')], max_output_tokens: 300, reasoning_effort: effort });
    expect(error).toBeUndefined();
    return fake.chatBodies()[0].think;
  };

  it('sends think false for reasoning effort none to a target with the reasoning capability', async () => {
    expect(await thinkSentWith('none')).toBe(false);
  });

  it.for(['minimal', 'low', 'high'] as const)('sends think true for reasoning effort %s to a target with the reasoning capability', async (effort) => {
    expect(await thinkSentWith(effort)).toBe(true);
  });

  it('sends truncate false on every request', async () => {
    const plain = await sentBody({ model: 'devstral-small-2', input: [userText('hi')] });
    const withTools = await sentBody({ model: 'devstral-small-2', input: [userText('hi')], tools: [readFileTool], max_output_tokens: 300 });
    expect(plain.truncate).toBe(false);
    expect(withTools.truncate).toBe(false);
  });
});
