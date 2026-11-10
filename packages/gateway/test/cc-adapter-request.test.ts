import { describe, expect, it } from 'vitest';
import { keyAuthSource, unauthenticatedSource } from '@momonga/gateway';
import type { AdapterRequest } from '@momonga/protocol';
import { CC_CAPABILITIES, collect, lastCompletionBody, listDirTool, makeAdapter, readFileTool, startFake, terminalOf, userText, MODEL_FRAMING } from './cc-support.ts';

const API_KEY = 'momonga-test-api-key';

const historyRequest = (): AdapterRequest => ({
  model: 'system',
  instructions: 'Be terse.',
  input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Dev rule.' }] },
    { type: 'message', role: 'system', content: 'Sys rule.' },
    { type: 'compaction_summary', summary: 'Earlier we discussed the parser.' },
    userText('Hello'),
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi there' }] },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'secret reasoning' }] },
    { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' },
    { type: 'function_call', call_id: 'c2', name: 'list_dir', arguments: '{"dir":"."}' },
    { type: 'function_call_output', call_id: 'c1', output: 'A' },
    { type: 'function_call_output', call_id: 'c2', output: 'B' },
  ],
  tools: [readFileTool, listDirTool],
  max_output_tokens: 64,
  temperature: 0.2,
});

describe('chat-completions request mapping', () => {
  it('creates an adapter of kind chat-completions', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    expect(makeAdapter(fake).kind).toBe('chat-completions');
  });

  it('maps instructions, system and developer text into one leading system message and the compaction summary into a user message', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const { error } = await collect(makeAdapter(fake), historyRequest());
    expect(error).toBeUndefined();
    const messages = lastCompletionBody(fake).messages as any[];
    expect(messages.filter((message) => message.role === 'system')).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    const system = messages[0].content as string;
    expect(typeof system).toBe('string');
    const positions = ['Be terse.', 'Dev rule.', 'Sys rule.'].map((text) => system.indexOf(text));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(system).not.toContain('Earlier we discussed the parser.');
    expect(messages[1]).toEqual({
      role: 'user',
      content: `<conversation_summary>\n${MODEL_FRAMING}\nEarlier we discussed the parser.\n</conversation_summary>\n\nHello`,
    });
  });

  it('maps messages, groups consecutive function calls into one assistant message, maps outputs to tool messages, and drops reasoning', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    await collect(makeAdapter(fake), historyRequest());
    const messages = lastCompletionBody(fake).messages as any[];
    expect(messages).toHaveLength(6);
    expect(messages[1]).toEqual({ role: 'user', content: `<conversation_summary>\n${MODEL_FRAMING}\nEarlier we discussed the parser.\n</conversation_summary>\n\nHello` });
    expect(messages[2]).toEqual({ role: 'assistant', content: 'Hi there' });
    expect(messages[3].role).toBe('assistant');
    expect([null, undefined, '']).toContain(messages[3].content);
    expect(messages[3].tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
      { id: 'c2', type: 'function', function: { name: 'list_dir', arguments: '{"dir":"."}' } },
    ]);
    expect(messages[4]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'A' });
    expect(messages[5]).toEqual({ role: 'tool', tool_call_id: 'c2', content: 'B' });
    expect(JSON.stringify(messages)).not.toContain('secret reasoning');
  });

  it('sends tools as chat-completions functions, max_completion_tokens, temperature, model and streaming with usage', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    await collect(makeAdapter(fake), historyRequest());
    const body = lastCompletionBody(fake);
    expect(body.model).toBe('system');
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'read_file', description: readFileTool.description, parameters: readFileTool.parameters } },
      { type: 'function', function: { name: 'list_dir', description: listDirTool.description, parameters: listDirTool.parameters } },
    ]);
    expect(body.max_completion_tokens).toBe(64);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBe(0.2);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('never sends stop or a json_object response_format', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const { events } = await collect(makeAdapter(fake), historyRequest());
    const body = lastCompletionBody(fake);
    expect('stop' in body).toBe(false);
    expect(body.response_format?.type).not.toBe('json_object');
    expect(terminalOf(events).type).toBe('response.completed');
  });

  it.each([
    ['auto', 'auto'],
    ['required', 'required'],
    ['none', 'none'],
    [{ type: 'function', name: 'read_file' }, { type: 'function', function: { name: 'read_file' } }],
  ] as const)('maps tool_choice %j to %j', async (choice, expected) => {
    const fake = await startFake({ scenario: 'tools-ok' });
    await collect(makeAdapter(fake), { model: 'system', input: [userText('hi')], tools: [readFileTool], tool_choice: choice });
    expect(lastCompletionBody(fake).tool_choice).toEqual(expected);
  });

  it('omits tools and tool_choice when the request has no tools', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    await collect(makeAdapter(fake), { model: 'system', input: [userText('hi')] });
    const body = lastCompletionBody(fake);
    expect('tools' in body).toBe(false);
    expect('tool_choice' in body).toBe(false);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('sends a bearer Authorization header from a key source and none from the unauthenticated source', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const seen: unknown[] = [];
    await collect(
      makeAdapter(fake, {
        authSource: keyAuthSource(async (target) => {
          seen.push(target);
          return API_KEY;
        }),
      }),
      { model: 'system', input: [userText('hi')] },
    );
    expect(fake.requests.at(-1)?.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(seen).toContainEqual({ name: 'fm', display: 'fm', model: 'system' });

    const bare = await startFake({ scenario: 'tools-ok' });
    await collect(makeAdapter(bare, { authSource: unauthenticatedSource }), { model: 'system', input: [userText('hi')] });
    expect(bare.requests.at(-1)?.headers['authorization']).toBeUndefined();
  });

  it('does not leak the api key into errors', async () => {
    const fake = await startFake({
      scenario: 'tools-ok',
      script: [{ kind: 'error', status: 400, body: { error: { message: 'bad request', type: 'invalid_request_error', param: null, code: null } } }],
    });
    const adapter = makeAdapter(fake, { authSource: keyAuthSource(async () => API_KEY) });
    const { error } = await collect(adapter, { model: 'system', input: [userText('hi')] });
    expect(error).toBeDefined();
    expect(String(error)).not.toContain(API_KEY);
    expect(JSON.stringify(adapter.classify(error))).not.toContain(API_KEY);
  });

  it('passes the target to capabilities', async () => {
    const fake = await startFake({ scenario: 'tools-ok' });
    const seen: unknown[] = [];
    const adapter = makeAdapter(fake, {
      capabilities: async (target) => {
        seen.push(target);
        return CC_CAPABILITIES;
      },
    });
    expect(await adapter.capabilities({ name: 'fm', display: 'fm', model: 'system' })).toEqual(CC_CAPABILITIES);
    expect(seen).toEqual([{ name: 'fm', display: 'fm', model: 'system' }]);
  });
});
