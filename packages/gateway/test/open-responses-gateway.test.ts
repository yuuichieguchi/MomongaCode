import { describe, expect, it } from 'vitest';
import {
  functionCallEvents,
  messageEvents,
  openResponsesErrorFrame,
  openResponsesErrorReply,
  openResponsesStream,
  openResponsesTextReply,
  openResponsesToolCallReply,
  openingEvents,
  refusalEvents,
  terminalEvent,
  usageOf,
  waitFor,
} from '@momonga/testkit';
import { expectErrorBody, postJson, readJson, userInput } from './gateway-helpers.ts';
import { REMOTE_CAPABILITIES, readFileTool, startOpenResponsesGateway, streamResponse, terminalOf, textOf, typesOf } from './upstream-gateway-support.ts';

const BEARER_KEY = 'or-fake-key-0000000000000000';

describe('open-responses relay through the gateway: text', () => {
  it('relays text deltas, reported usage and the request in Open Responses form', async () => {
    const message = messageEvents(['Hel', 'lo ', 'world']);
    const gateway = await startOpenResponsesGateway({
      apiKey: BEARER_KEY,
      sentKey: BEARER_KEY,
      script: [openResponsesStream([...openingEvents(), ...message.events, terminalEvent({ kind: 'completed', usage: usageOf(40, 9) }, [message.item])])],
    });
    const frames = await streamResponse(gateway, { instructions: 'be brief', temperature: 0.2, max_output_tokens: 300 });
    const terminal = terminalOf(frames);
    expect(terminal.type).toBe('response.completed');
    expect(textOf(terminal.response)).toBe('Hello world');
    expect(frames.filter((frame) => frame.data.type === 'response.output_text.delta').map((frame) => frame.data.delta)).toEqual(['Hel', 'lo ', 'world']);
    expect(terminal.response.usage).toEqual(usageOf(40, 9));
    expect(terminal.response.momonga).toMatchObject({ usageSource: 'reported', attempts: 1 });

    const [request] = gateway.fake.requests;
    expect(request?.path).toBe('/v1/responses');
    expect(request?.headers['authorization']).toBe(`Bearer ${BEARER_KEY}`);
    expect(request?.body).toEqual({
      model: 'upstream-model',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      stream: true,
      store: false,
      instructions: 'be brief',
      temperature: 0.2,
      max_output_tokens: 300,
    });
  });

  it('sends no authorization header for a target without a credential', async () => {
    const gateway = await startOpenResponsesGateway({ script: [openResponsesTextReply(['ok'])] });
    await streamResponse(gateway);
    expect(gateway.fake.requests[0]?.headers['authorization']).toBeUndefined();
  });

  it('accepts a stream that ends without the [DONE] marker after the terminal event', async () => {
    const message = messageEvents(['x']);
    const gateway = await startOpenResponsesGateway({
      script: [openResponsesStream([...openingEvents(), ...message.events, terminalEvent({ kind: 'completed' }, [message.item])], { done: false })],
    });
    expect(terminalOf(await streamResponse(gateway)).type).toBe('response.completed');
  });

  it('takes content from output_item.done when the upstream sent no deltas', async () => {
    const message = messageEvents(['full text']);
    const call = functionCallEvents('call_up', 'read_file', ['{"path":"a"}'], 1);
    const withoutDeltas = [...message.events, ...call.events].filter(
      (event) => event.type !== 'response.output_text.delta' && event.type !== 'response.function_call_arguments.delta',
    );
    const gateway = await startOpenResponsesGateway({
      script: [openResponsesStream([...openingEvents(), ...withoutDeltas, terminalEvent({ kind: 'completed' }, [message.item, call.item])])],
    });
    const terminal = terminalOf(await streamResponse(gateway, { tools: [readFileTool] }));
    expect(textOf(terminal.response)).toBe('full text');
    expect(terminal.response.output[1]).toMatchObject({ type: 'function_call', arguments: '{"path":"a"}' });
  });

  it('keeps reasoning items out of the output', async () => {
    const message = messageEvents(['answer']);
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [] };
    const gateway = await startOpenResponsesGateway({
      script: [
        openResponsesStream([
          ...openingEvents(),
          { type: 'response.output_item.added', output_index: 0, item: reasoning },
          { type: 'response.output_item.done', output_index: 0, item: reasoning },
          ...message.events.map((event) => ({ ...event, output_index: 1 })),
          terminalEvent({ kind: 'completed' }, [reasoning, message.item]),
        ]),
      ],
    });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(terminal.response.output.map((item: any) => item.type)).toEqual(['message']);
  });
});

describe('open-responses relay through the gateway: tool calls', () => {
  it('relays a function_call whose arguments arrive in split deltas', async () => {
    const gateway = await startOpenResponsesGateway({ script: [openResponsesToolCallReply('call_up', 'read_file', ['{"pa', 'th": "/tm', 'p/a.txt"}'])] });
    const frames = await streamResponse(gateway, { tools: [readFileTool], tool_choice: 'auto', parallel_tool_calls: false });
    const terminal = terminalOf(frames);
    expect(terminal.type).toBe('response.completed');
    const calls = terminal.response.output.filter((item: any) => item.type === 'function_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'read_file', arguments: '{"path": "/tmp/a.txt"}' });
    expect(calls[0].call_id).toMatch(/^call_[0-9a-f]{32}$/);
    expect(frames.filter((frame) => frame.data.type === 'response.function_call_arguments.delta').map((frame) => frame.data.delta)).toEqual([
      '{"pa',
      'th": "/tm',
      'p/a.txt"}',
    ]);
    const body = gateway.fake.requests[0]?.body as any;
    expect(body.tools).toEqual([readFileTool]);
    expect(body.tool_choice).toBe('auto');
    expect(body.parallel_tool_calls).toBe(false);
  });

  it('sends tool history without gateway item ids', async () => {
    const gateway = await startOpenResponsesGateway({ script: [openResponsesTextReply(['done'])] });
    await streamResponse(gateway, {
      tools: [readFileTool],
      input: [
        ...userInput('read it'),
        { type: 'function_call', id: 'fc_gateway', call_id: 'call_abc', name: 'read_file', arguments: '{"path":"a"}', status: 'completed' },
        { type: 'function_call_output', id: 'fo_gateway', call_id: 'call_abc', output: 'contents', status: 'completed' },
      ],
    });
    expect((gateway.fake.requests[0]?.body as any).input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read it' }] },
      { type: 'function_call', call_id: 'call_abc', name: 'read_file', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'call_abc', output: 'contents' },
    ]);
  });

  it('rejects tools for a target that declares toolCalling none', async () => {
    const gateway = await startOpenResponsesGateway({
      script: [openResponsesTextReply(['x'])],
      capabilities: { ...REMOTE_CAPABILITIES, toolCalling: 'none' },
    });
    const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'fast', tools: [readFileTool], input: userInput('hi') }));
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'capability_unsupported' });
    expect(gateway.fake.requests).toEqual([]);
  });
});

describe('open-responses relay through the gateway: terminal semantics', () => {
  it('relays response.incomplete with max_output_tokens', async () => {
    const message = messageEvents(['cut off'], 'incomplete');
    const gateway = await startOpenResponsesGateway({
      script: [openResponsesStream([...openingEvents(), ...message.events, terminalEvent({ kind: 'incomplete', reason: 'max_output_tokens' }, [message.item])])],
    });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(terminal.type).toBe('response.incomplete');
    expect(terminal.response.incomplete_details).toEqual({ reason: 'max_output_tokens' });
    expect(textOf(terminal.response)).toBe('cut off');
  });

  it('relays a refusal part and response.incomplete with content_filter', async () => {
    const refusal = refusalEvents('I cannot help with that');
    const gateway = await startOpenResponsesGateway({
      script: [openResponsesStream([...openingEvents(), ...refusal.events, terminalEvent({ kind: 'incomplete', reason: 'content_filter' }, [refusal.item])])],
    });
    const frames = await streamResponse(gateway);
    const terminal = terminalOf(frames);
    expect(terminal.type).toBe('response.incomplete');
    expect(terminal.response.incomplete_details).toEqual({ reason: 'content_filter' });
    expect(typesOf(frames)).toContain('response.refusal.delta');
    expect(terminal.response.output[0].content[0]).toEqual({ type: 'refusal', refusal: 'I cannot help with that' });
  });

  it('fails the response for an unsupported incomplete reason', async () => {
    const message = messageEvents(['x']);
    const gateway = await startOpenResponsesGateway({
      script: [openResponsesStream([...openingEvents(), ...message.events, terminalEvent({ kind: 'incomplete', reason: 'something_new' }, [message.item])])],
    });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error).toMatchObject({ code: 'upstream_protocol_error', type: 'model_error' });
  });

  it('relays an upstream response.failed with its code', async () => {
    const gateway = await startOpenResponsesGateway({
      script: [openResponsesStream([...openingEvents(), terminalEvent({ kind: 'failed', code: 'server_error', message: 'the model crashed' }, [])])],
    });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error).toMatchObject({ code: 'server_error', message: 'the model crashed', type: 'server_error' });
  });

  it('fails the response when the stream ends without a terminal event', async () => {
    const message = messageEvents(['x']);
    const gateway = await startOpenResponsesGateway({ script: [openResponsesStream([...openingEvents(), ...message.events], { done: false })] });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error.code).toBe('upstream_protocol_error');
  });
});

describe('open-responses relay through the gateway: failures', () => {
  it('reports an error event after output started as stream_interrupted', async () => {
    const message = messageEvents(['partial']);
    const gateway = await startOpenResponsesGateway({
      script: [openResponsesStream([...openingEvents(), ...message.events.slice(0, 3), openResponsesErrorFrame('server_error', 'overloaded', 'upstream overloaded')], { done: false })],
    });
    const frames = await streamResponse(gateway);
    const terminal = terminalOf(frames);
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error).toMatchObject({ code: 'stream_interrupted', type: 'server_error' });
    expect(terminal.response.error.message).toContain('upstream overloaded');
    expect(typesOf(frames)).toContain('response.output_text.delta');
    expect(gateway.fake.requests).toHaveLength(1);
  });

  it('reports a connection reset after output started as stream_interrupted', async () => {
    const message = messageEvents(['partial']);
    const gateway = await startOpenResponsesGateway({
      script: [openResponsesStream([...openingEvents(), ...message.events.slice(0, 3)], { trailer: 'reset', done: false })],
    });
    const terminal = terminalOf(await streamResponse(gateway));
    expect(terminal.type).toBe('response.failed');
    expect(terminal.response.error.code).toBe('stream_interrupted');
    expect(gateway.fake.requests).toHaveLength(1);
  });

  it('retries an error event that arrives before any output and then succeeds', async () => {
    const gateway = await startOpenResponsesGateway({
      script: [openResponsesStream([openResponsesErrorFrame('server_error', 'overloaded', 'busy')], { done: false }), openResponsesTextReply(['recovered'])],
      config: { retry: { maxAttempts: 2, baseMs: 100, maxMs: 10_000 } },
    });
    const pending = streamResponse(gateway);
    await waitFor(() => gateway.fake.requests.length === 1 && gateway.timers.pending().length > 0, { description: 'retry timer' });
    gateway.timers.advance(10_000);
    const terminal = terminalOf(await pending);
    expect(terminal.type).toBe('response.completed');
    expect(terminal.response.momonga.attempts).toBe(2);
  });

  it('does not retry a pre-output invalid_request error event', async () => {
    const gateway = await startOpenResponsesGateway({
      script: [openResponsesStream([openResponsesErrorFrame('invalid_request', 'bad_input', 'unknown parameter')], { done: false })],
    });
    const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(400);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'bad_input' });
    expect(gateway.fake.requests).toHaveLength(1);
  });

  it('honours Retry-After on a 429 before retrying', async () => {
    const gateway = await startOpenResponsesGateway({
      script: [openResponsesErrorReply(429, 'too_many_requests', 'rate_limited', 'slow down', { 'retry-after': '7' }), openResponsesTextReply(['after wait'])],
      config: { retry: { maxAttempts: 2, baseMs: 100, maxMs: 10_000 } },
    });
    const pending = streamResponse(gateway);
    await waitFor(() => gateway.fake.requests.length === 1 && gateway.timers.pending().length > 0, { description: 'retry timer' });
    expect(gateway.timers.pending().map((timer) => timer.delayMs)).toEqual([7000]);
    gateway.timers.advance(6999);
    expect(gateway.fake.requests).toHaveLength(1);
    gateway.timers.advance(1);
    const terminal = terminalOf(await pending);
    expect(textOf(terminal.response)).toBe('after wait');
    expect(gateway.fake.requests).toHaveLength(2);
  });

  it('surfaces the final 429 with a Retry-After header when retries are exhausted', async () => {
    const gateway = await startOpenResponsesGateway({
      script: [openResponsesErrorReply(429, 'too_many_requests', 'rate_limited', 'slow down', { 'retry-after': '7' })],
      config: { retry: { maxAttempts: 1, baseMs: 100, maxMs: 10_000 } },
    });
    const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('7');
    expectErrorBody(response.body, { type: 'too_many_requests', code: 'rate_limited' });
  });

  it('answers an authentication failure with 401 authentication_failed and does not retry', async () => {
    const gateway = await startOpenResponsesGateway({ apiKey: BEARER_KEY, sentKey: 'or-wrong-key-00000000000000', script: [openResponsesTextReply(['unreachable'])] });
    const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'fast', input: userInput('hi') }));
    expect(response.status).toBe(401);
    expectErrorBody(response.body, { type: 'invalid_request', code: 'authentication_failed' });
    expect(gateway.fake.requests).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toContain('or-wrong-key');
  });
});

describe('open-responses relay through the gateway: compaction', () => {
  it('summarises through the same streaming path', async () => {
    const gateway = await startOpenResponsesGateway({ script: [openResponsesTextReply(['The user asked for X.'])] });
    const response = await readJson(await postJson(gateway.client, '/v1/responses/compact', { model: 'fast', input: userInput('do X') }));
    expect(response.status).toBe(200);
    expect(response.body.output[0].type).toBe('compaction');
    const body = gateway.fake.requests[0]?.body as { instructions: string; input: Array<{ content: string }> };
    expect(body.instructions).toContain('handoff note');
    expect(body.input[0]?.content).toContain('<transcript>');
  });
});
