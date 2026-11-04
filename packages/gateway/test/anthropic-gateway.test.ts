import { describe, expect, it } from 'vitest';
import {
  anthropicBlockDelta,
  anthropicBlockStart,
  anthropicBlockStop,
  anthropicCountTokensReply,
  anthropicErrorEvent,
  anthropicErrorReply,
  anthropicMessageEnd,
  anthropicMessageStart,
  anthropicStream,
  anthropicTextBlock,
  anthropicTextReply,
  anthropicToolUseBlock,
  anthropicToolUseReply,
  waitFor,
} from '@momonga/testkit';
import { MAX_PAUSE_CONTINUATIONS } from '../src/adapters/anthropic/constants.ts';
import { expectErrorBody, postJson, readJson, userInput } from './gateway-helpers.ts';
import { FAKE_API_KEY, REMOTE_CAPABILITIES, readFileTool, startAnthropicGateway, streamResponse, terminalOf, textOf, typesOf } from './upstream-gateway-support.ts';

describe('anthropic adapter through the gateway: text', () => {
  it('streams text deltas and completes with usage that includes the cache fields', async () => {
    const gateway = await startAnthropicGateway({
      script: [
        anthropicStream([
          anthropicMessageStart({ input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 1 }),
          ...anthropicTextBlock(0, ['Hel', 'lo ', 'world']),
          ...anthropicMessageEnd('end_turn', { output_tokens: 7 }),
        ]),
      ],
    });
    const frames = await streamResponse(gateway, { instructions: 'be brief', temperature: 0.5, top_p: 0.9 });
    const terminal = terminalOf(frames);
    expect(terminal.type).toBe('response.completed');
    expect(textOf(terminal.response)).toBe('Hello world');
    expect(frames.filter((frame) => frame.data.type === 'response.output_text.delta').map((frame) => frame.data.delta)).toEqual(['Hel', 'lo ', 'world']);
    expect(terminal.response.usage).toEqual({
      input_tokens: 160,
      output_tokens: 7,
      total_tokens: 167,
      input_tokens_details: { cached_tokens: 50 },
      output_tokens_details: { reasoning_tokens: 0 },
    });
    expect(terminal.response.momonga).toMatchObject({ usageSource: 'reported', attempts: 1 });

    const [request] = gateway.fake.requests;
    expect(request?.headers['x-api-key']).toBe(FAKE_API_KEY);
    expect(request?.headers['anthropic-version']).toBe('2023-06-01');
    expect(request?.body).toEqual({
      model: 'upstream-model',
      max_tokens: REMOTE_CAPABILITIES.maxOutputTokens,
      stream: true,
      system: [{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] }],
      temperature: 0.5,
      top_p: 0.9,
    });
  });

  it('uses the request max_output_tokens instead of the declared maximum', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicTextReply(['ok'])] });
    await streamResponse(gateway, { max_output_tokens: 99 });
    expect((gateway.fake.requests[0]?.body as { max_tokens: number }).max_tokens).toBe(99);
  });

  it('ignores ping events and unknown event types', async () => {
    const gateway = await startAnthropicGateway({
      script: [
        anthropicStream([
          { event: 'ping', data: { type: 'ping' } },
          anthropicMessageStart(),
          { event: 'future_event', data: { type: 'future_event', payload: 1 } },
          ...anthropicTextBlock(0, ['x']),
          ...anthropicMessageEnd('end_turn'),
        ]),
      ],
    });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(textOf(terminal.response)).toBe('x');
  });

  it('keeps thinking blocks out of the output', async () => {
    const gateway = await startAnthropicGateway({
      script: [
        anthropicStream([
          anthropicMessageStart(),
          { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } },
          { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } } },
          { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
          ...anthropicTextBlock(1, ['answer']),
          ...anthropicMessageEnd('end_turn'),
        ]),
      ],
    });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(terminal.response.output).toHaveLength(1);
    expect(textOf(terminal.response)).toBe('answer');
  });
});

describe('anthropic adapter through the gateway: tool calls', () => {
  it('relays a tool_use whose JSON arguments arrive in split deltas', async () => {
    const gateway = await startAnthropicGateway({
      script: [
        anthropicStream([
          anthropicMessageStart(),
          ...anthropicTextBlock(0, ['Let me look.']),
          ...anthropicToolUseBlock(1, 'toolu_01A', 'read_file', ['', '{"pa', 'th": "/tm', 'p/a.txt"}']),
          ...anthropicMessageEnd('tool_use'),
        ]),
      ],
    });
    const frames = await streamResponse(gateway, { tools: [readFileTool] });
    const terminal = terminalOf(frames);
    expect(terminal.type).toBe('response.completed');
    const calls = terminal.response.output.filter((item: any) => item.type === 'function_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'read_file', arguments: '{"path": "/tmp/a.txt"}', status: 'completed' });
    expect(calls[0].call_id).toMatch(/^call_[0-9a-f]{32}$/);
    expect(terminal.response.output.map((item: any) => item.type)).toEqual(['message', 'function_call']);
    expect(frames.filter((frame) => frame.data.type === 'response.function_call_arguments.delta').map((frame) => frame.data.delta)).toEqual([
      '{"pa',
      'th": "/tm',
      'p/a.txt"}',
    ]);
    const body = gateway.fake.requests[0]?.body as { tools: unknown[]; tool_choice?: unknown };
    expect(body.tools).toEqual([
      {
        name: 'read_file',
        description: 'Read a file from the workspace',
        input_schema: readFileTool.parameters,
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(body.tool_choice).toBeUndefined();
  });

  it('turns an argument-less tool_use into empty-object arguments', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicToolUseReply('toolu_02', 'list_dir', [])] });
    const terminal = terminalOf(await streamResponse(gateway, { tools: [{ type: 'function', name: 'list_dir', description: 'List files', parameters: { type: 'object', properties: {} } }] }));
    expect(terminal.response.output[0]).toMatchObject({ type: 'function_call', name: 'list_dir', arguments: '{}' });
  });

  it('sends tool history as tool_use and tool_result blocks and honours tool_choice', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicTextReply(['done'])] });
    await streamResponse(gateway, {
      tools: [readFileTool],
      tool_choice: 'required',
      parallel_tool_calls: false,
      input: [
        ...userInput('read it'),
        { type: 'function_call', call_id: 'call_abc', name: 'read_file', arguments: '{"path":"a"}' },
        { type: 'function_call_output', call_id: 'call_abc', output: 'contents' },
        { type: 'message', role: 'user', content: 'thanks' },
      ],
    });
    const body = gateway.fake.requests[0]?.body as any;
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_abc', name: 'read_file', input: { path: 'a' } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_abc', content: 'contents' },
          { type: 'text', text: 'thanks', cache_control: { type: 'ephemeral' } },
        ],
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'any', disable_parallel_tool_use: true });
  });
});

describe('anthropic adapter through the gateway: terminal semantics', () => {
  it('maps max_tokens to an incomplete response with max_output_tokens', async () => {
    const gateway = await startAnthropicGateway({
      script: [anthropicStream([anthropicMessageStart(), ...anthropicTextBlock(0, ['cut off']), ...anthropicMessageEnd('max_tokens')])],
    });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(terminal.type).toBe('response.incomplete');
    expect(terminal.response.incomplete_details).toEqual({ reason: 'max_output_tokens' });
    expect(textOf(terminal.response)).toBe('cut off');
  });

  it('marks a tool_use cut off by max_tokens as incomplete', async () => {
    const gateway = await startAnthropicGateway({
      script: [
        anthropicStream([
          anthropicMessageStart(),
          ...anthropicToolUseBlock(0, 'toolu_03', 'read_file', ['{"path": "/t']).slice(0, 2),
          ...anthropicMessageEnd('max_tokens'),
        ]),
      ],
    });
    const terminal = terminalOf(await streamResponse(gateway, { tools: [readFileTool] }));
    expect(terminal.type).toBe('response.incomplete');
    expect(terminal.response.output[0]).toMatchObject({ type: 'function_call', status: 'incomplete', arguments: '{"path": "/t' });
  });

  it('fails a model_context_window_exceeded stop with a typed invalid_request instead of a truncation', async () => {
    const gateway = await startAnthropicGateway({
      script: [anthropicStream([anthropicMessageStart(), ...anthropicTextBlock(0, ['part']), ...anthropicMessageEnd('model_context_window_exceeded')])],
    });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error).toMatchObject({ code: 'context_window_exceeded', type: 'invalid_request' });
    expect(gateway.fake.requests).toHaveLength(1);
  });

  it('maps a refusal stop reason to an incomplete response with content_filter', async () => {
    const gateway = await startAnthropicGateway({
      script: [anthropicStream([anthropicMessageStart(), ...anthropicTextBlock(0, ['I cannot help']), ...anthropicMessageEnd('refusal')])],
    });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(terminal.type).toBe('response.incomplete');
    expect(terminal.response.incomplete_details).toEqual({ reason: 'content_filter' });
  });

  it.for(['compaction', 'brand_new_reason'])('fails the response for the unsupported stop reason %s', async (reason) => {
    const gateway = await startAnthropicGateway({
      script: [anthropicStream([anthropicMessageStart(), ...anthropicTextBlock(0, ['x']), ...anthropicMessageEnd(reason)])],
    });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error).toMatchObject({ code: 'upstream_protocol_error', type: 'model_error' });
  });

  it('fails the response when the stream ends without message_stop', async () => {
    const gateway = await startAnthropicGateway({
      script: [anthropicStream([anthropicMessageStart(), ...anthropicTextBlock(0, ['x'])])],
    });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error.code).toBe('upstream_protocol_error');
  });
});

describe('anthropic adapter through the gateway: failures', () => {
  it('reports an error event after output started as stream_interrupted', async () => {
    const gateway = await startAnthropicGateway({
      script: [anthropicStream([anthropicMessageStart(), ...anthropicTextBlock(0, ['partial']).slice(0, 2), anthropicErrorEvent('overloaded_error', 'Overloaded')])],
    });
    const frames = await streamResponse(gateway);
    const terminal = terminalOf(frames);
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error).toMatchObject({ code: 'stream_interrupted', type: 'server_error' });
    expect(terminal.response.error.message).toContain('Overloaded');
    expect(typesOf(frames)).toContain('response.output_text.delta');
    expect(gateway.fake.requests).toHaveLength(1);
  });

  it('reports a connection reset after output started as stream_interrupted', async () => {
    const gateway = await startAnthropicGateway({
      script: [anthropicStream([anthropicMessageStart(), ...anthropicTextBlock(0, ['partial']).slice(0, 2)], 'reset')],
    });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error.code).toBe('stream_interrupted');
    expect(gateway.fake.requests).toHaveLength(1);
  });

  it('retries an error event that arrives before any output and then succeeds', async () => {
    const gateway = await startAnthropicGateway({
      script: [anthropicStream([anthropicErrorEvent('overloaded_error', 'Overloaded')]), anthropicTextReply(['recovered'])],
      config: { retry: { maxAttempts: 2, baseMs: 100, maxMs: 10_000 } },
    });
    const pending = streamResponse(gateway);
    await waitFor(() => gateway.fake.requests.length === 1 && gateway.timers.pending().length > 0, { description: 'retry timer' });
    gateway.timers.advance(10_000);
    const terminal = terminalOf(await pending);
    expect(terminal.type).toBe('response.completed');
    expect(textOf(terminal.response)).toBe('recovered');
    expect(terminal.response.momonga.attempts).toBe(2);
  });

  it('honours Retry-After on a 429 before retrying', async () => {
    const gateway = await startAnthropicGateway({
      script: [anthropicErrorReply(429, 'rate_limit_error', 'slow down', { 'retry-after': '7' }), anthropicTextReply(['after wait'])],
      config: { retry: { maxAttempts: 2, baseMs: 100, maxMs: 10_000 } },
    });
    const pending = streamResponse(gateway);
    await waitFor(() => gateway.fake.requests.length === 1 && gateway.timers.pending().length > 0, { description: 'retry timer' });
    expect(gateway.timers.pending().map((timer) => timer.delayMs)).toEqual([7000]);
    gateway.timers.advance(6999);
    expect(gateway.fake.requests).toHaveLength(1);
    gateway.timers.advance(1);
    const terminal = terminalOf(await pending);
    expect(terminal.type).toBe('response.completed');
    expect(textOf(terminal.response)).toBe('after wait');
    expect(gateway.fake.requests).toHaveLength(2);
  });

  it('surfaces the final 429 with a Retry-After header when retries are exhausted', async () => {
    const gateway = await startAnthropicGateway({
      script: [anthropicErrorReply(429, 'rate_limit_error', 'slow down', { 'retry-after': '7' })],
      config: { retry: { maxAttempts: 1, baseMs: 100, maxMs: 10_000 } },
    });
    const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('7');
    expectErrorBody(response.body, { type: 'too_many_requests', code: 'rate_limit_error' });
    expect(response.body.error.message).toContain('slow down');
  });

  it('answers an authentication failure with 401 authentication_failed and does not retry', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicTextReply(['unreachable'])], sentKey: 'sk-ant-wrong-000000000000' });
    const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(401);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'authentication_failed' });
    expect(gateway.fake.requests).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toContain('sk-ant-wrong');
  });

  it('does not retry an invalid request', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicErrorReply(400, 'invalid_request_error', 'max_tokens: too large')] });
    const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'unsupported_request' });
    expect(gateway.fake.requests).toHaveLength(1);
  });

  it('does not retry a 5xx that carries x-should-retry: false', async () => {
    const gateway = await startAnthropicGateway({
      script: [anthropicErrorReply(500, 'api_error', 'deterministic failure', { 'x-should-retry': 'false' })],
    });
    const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(502);
    expectErrorBody(response.body, { type: 'server_error', code: 'api_error' });
    expect(gateway.fake.requests).toHaveLength(1);
  });
});

describe('anthropic adapter through the gateway: compaction', () => {
  it('summarises through the same streaming path', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicCountTokensReply(80), anthropicTextReply(['The user asked for X; file a.ts was read.'])] });
    const response = await readJson(
      await postJson(gateway.client, '/v1/responses/compact', {
        model: 'fast',
        input: [...userInput('do X'), { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }, { type: 'function_call_output', call_id: 'c1', output: 'body' }],
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body.output[0].type).toBe('compaction');
    expect(gateway.fake.requests[0]?.path).toBe('/v1/messages/count_tokens');
    const body = gateway.fake.requests[1]?.body as { system: Array<{ text: string; cache_control?: unknown }>; messages: Array<{ content: Array<{ text: string; cache_control?: unknown }> }> };
    expect(body.system[0]?.text).toContain('handoff note');
    expect(JSON.stringify(body)).not.toContain('cache_control');
    expect(body.messages[0]?.content[0]?.text).toContain('<tool_result id="c1">body</tool_result>');
  });

  it('sizes the summary request by counting the system and messages it will actually send', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicCountTokensReply(80), anthropicTextReply(['summary'])] });
    const response = await readJson(await postJson(gateway.client, '/v1/responses/compact', { model: 'fast', input: userInput('do X') }));
    expect(response.status).toBe(200);
    const [counted, sent] = gateway.fake.requests.map((request) => request.body as { model: string; system: unknown; messages: unknown });
    expect(Object.keys(counted as object).sort()).toEqual(['messages', 'model', 'system']);
    expect(counted?.model).toBe(sent?.model);
    expect(counted?.system).toEqual(sent?.system);
    expect(counted?.messages).toEqual(sent?.messages);
  });
});

describe('anthropic adapter through the gateway: pause_turn', () => {
  const pausedSegment = anthropicStream([
    anthropicMessageStart({ input_tokens: 10, output_tokens: 1 }),
    anthropicBlockStart(0, { type: 'thinking', thinking: '', signature: '' }),
    anthropicBlockDelta(0, { type: 'thinking_delta', thinking: 'plan' }),
    anthropicBlockDelta(0, { type: 'signature_delta', signature: 'sig-1' }),
    anthropicBlockStop(0),
    ...anthropicTextBlock(1, ['part one, ']),
    anthropicBlockStart(2, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }),
    anthropicBlockDelta(2, { type: 'input_json_delta', partial_json: '{"query":' }),
    anthropicBlockDelta(2, { type: 'input_json_delta', partial_json: '"momonga"}' }),
    anthropicBlockStop(2),
    ...anthropicMessageEnd('pause_turn', { output_tokens: 5 }),
  ]);

  it('reports no contextInputTokens for a turn that was never paused', async () => {
    const gateway = await startAnthropicGateway({
      script: [anthropicStream([anthropicMessageStart({ input_tokens: 12, output_tokens: 1 }), ...anthropicTextBlock(0, ['plain']), ...anthropicMessageEnd('end_turn', { output_tokens: 3 })])],
    });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(terminal.response.usage).toMatchObject({ input_tokens: 12 });
    expect(terminal.response.momonga.contextInputTokens).toBeUndefined();
  });

  it('continues the paused turn with the received content as an assistant message and joins the segments into one response', async () => {
    const gateway = await startAnthropicGateway({
      script: [pausedSegment, anthropicStream([anthropicMessageStart({ input_tokens: 20, output_tokens: 1 }), ...anthropicTextBlock(0, ['part two']), ...anthropicMessageEnd('end_turn', { output_tokens: 7 })])],
    });
    const frames = await streamResponse(gateway, { tools: [readFileTool] });
    const terminal = terminalOf(frames);
    expect(terminal.type).toBe('response.completed');
    expect(textOf(terminal.response)).toBe('part one, part two');
    expect(typesOf(frames).filter((type) => type === 'response.created')).toHaveLength(1);
    expect(terminal.response.usage).toMatchObject({ input_tokens: 30, output_tokens: 12, total_tokens: 42 });
    expect(terminal.response.momonga.contextInputTokens).toBe(10);
    expect(gateway.fake.requests).toHaveLength(2);
    const [first, second] = gateway.fake.requests.map((request) => request.body as { messages: Array<{ role: string; content: unknown }>; tools: unknown });
    expect(second?.tools).toEqual(first?.tools);
    expect(second?.messages.slice(0, first?.messages.length)).toEqual(first?.messages);
    expect(second?.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
        { type: 'text', text: 'part one, ' },
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'momonga' } },
      ],
    });
  });

  it('keeps the earlier paused content when the turn pauses again', async () => {
    const secondPause = anthropicStream([anthropicMessageStart(), ...anthropicTextBlock(0, ['middle, ']), ...anthropicMessageEnd('pause_turn')]);
    const gateway = await startAnthropicGateway({
      script: [pausedSegment, secondPause, anthropicTextReply(['end'])],
    });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(textOf(terminal.response)).toBe('part one, middle, end');
    const third = gateway.fake.requests[2]?.body as { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> };
    expect(third.messages.at(-1)?.content.map((block) => block.type)).toEqual(['thinking', 'text', 'server_tool_use', 'text']);
    expect(third.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
  });

  it('fails the response with a typed code when the turn pauses more than the continuation cap', async () => {
    const gateway = await startAnthropicGateway({ respond: () => anthropicStream([anthropicMessageStart(), ...anthropicTextBlock(0, ['x']), ...anthropicMessageEnd('pause_turn')]) });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error).toMatchObject({ code: 'pause_turn_limit_exceeded' });
    expect(gateway.fake.requests).toHaveLength(MAX_PAUSE_CONTINUATIONS + 1);
  });
});

describe('anthropic adapter through the gateway: count_tokens', () => {
  const count = (gateway: Awaited<ReturnType<typeof startAnthropicGateway>>, body: Record<string, unknown>) =>
    postJson(gateway.client, '/v1/momonga/count_tokens', { model: 'fast', ...body }).then(readJson);

  it('counts through the Anthropic endpoint with the documented request fields and reports an exact count', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicCountTokensReply(321)] });
    const response = await count(gateway, { instructions: 'be brief', input: userInput('hello'), tools: [readFileTool] });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ input_tokens: 321, method: 'exact', error_bound: 0, error_shape: { ratio: 0, minimum: 0 } });
    const [request] = gateway.fake.requests;
    expect(request?.path).toBe('/v1/messages/count_tokens');
    expect(request?.headers['x-api-key']).toBe(FAKE_API_KEY);
    expect(Object.keys(request?.body as object).sort()).toEqual(['messages', 'model', 'system', 'tools']);
    expect(JSON.stringify(request?.body)).not.toContain('cache_control');
  });

  it('refuses locally to count an image given by URL because the endpoint cannot', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicCountTokensReply(1)], capabilities: { ...REMOTE_CAPABILITIES, ...SEEING } });
    const response = await count(gateway, { input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/a.png' }] }] });
    expect(response.status).toBe(400);
    expect(gateway.fake.requests).toEqual([]);
  });

  it('propagates an upstream failure instead of estimating', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicErrorReply(400, 'invalid_request_error', 'bad count')] });
    const response = await count(gateway, { input: userInput('hello') });
    expect(response.status).toBe(400);
  });
});

const SEEING = { imageInput: true, imageTokens: { pixelsPerToken: 750, maxTokens: 1600, minTokens: 1 } } as const;

describe('anthropic adapter through the gateway: images', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const imageInput = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'see' }, { type: 'input_image', image_url: PNG }] }];

  it('sends the image block when the target declares imageInput', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicTextReply(['ok'])], capabilities: { ...REMOTE_CAPABILITIES, ...SEEING } });
    const terminal = terminalOf(await streamResponse(gateway, { input: imageInput as never }));
    expect(terminal.type).toBe('response.completed');
    const body = gateway.fake.requests[0]?.body as { messages: Array<{ content: Array<{ type: string }> }> };
    expect(body.messages[0]?.content.map((block) => block.type)).toEqual(['text', 'image']);
  });

  it('rejects the request before any upstream call when the target does not declare imageInput', async () => {
    const gateway = await startAnthropicGateway({ script: [anthropicTextReply(['ok'])] });
    const response = await postJson(gateway.client, '/v1/responses', { model: 'fast', input: imageInput });
    expect(response.status).toBe(400);
    expect(gateway.fake.requests).toEqual([]);
  });
});
