import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createScriptedAdapter, textResponseEvents, waitFor } from '@momonga/testkit';
import { registerCleanup, startGateway, userInput, validator } from './gateway-helpers.ts';
import type { Harness } from './gateway-helpers.ts';
import { REDACTED, TEST_API_KEY, expectNoCredential, expectRedacted } from './credential-support.ts';

const DEBUG_TOKEN = 'momonga-ws-debug-token';
const CONNECTION_LIMIT_MS = 5000;

type Message = Record<string, any>;

type Client = {
  socket: WebSocket;
  send(message: unknown): void;
  untilTerminal(): Promise<Message[]>;
  closed: Promise<number>;
};

const TERMINAL = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error']);

const wrap = (socket: WebSocket): Client => {
  const messages: Message[] = [];
  const waiters: Array<() => void> = [];
  socket.on('message', (data) => {
    messages.push(JSON.parse(data.toString()) as Message);
    for (const waiter of waiters.splice(0)) waiter();
  });
  const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
  registerCleanup(() => socket.terminate());
  return {
    socket,
    send: (message) => socket.send(JSON.stringify(message)),
    closed,
    untilTerminal: async () => {
      for (;;) {
        const end = messages.findIndex((message) => TERMINAL.has(message['type']));
        if (end >= 0) return messages.splice(0, end + 1);
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
};

const open = (url: string, headers: Record<string, string> = {}): Promise<Client> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once('open', () => resolve(wrap(socket)));
    socket.once('unexpected-response', (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)));
    socket.once('error', reject);
  });

const connectUnix = (harness: Harness): Promise<Client> => open(`ws+unix://${harness.socketPath}:/v1/responses`);

const create = (extra: Record<string, unknown> = {}): Message => ({ type: 'response.create', model: 'fast', store: false, input: userInput('hi'), ...extra });

const textCall = (text: string) => ({ events: textResponseEvents({ model: 'scripted-primary', chunks: [text] }) });

describe('WebSocket transport over the unix socket', () => {
  it('streams the standard events for a response.create and sends no [DONE] marker', async () => {
    const adapter = createScriptedAdapter({ calls: [textCall('hello')] });
    const harness = await startGateway({ adapters: { primary: adapter } });
    const client = await connectUnix(harness);
    client.send(create());
    const turn = await client.untilTerminal();
    expect(turn.map((message) => message['type'])).toEqual(expect.arrayContaining(['response.created', 'response.output_text.delta', 'response.completed']));
    expect(turn.at(-1)?.['type']).toBe('response.completed');
    expect(validator.validate('ResponseCompletedStreamingEvent', turn.at(-1)).errors).toEqual([]);
    const sequence = turn.map((message) => message['sequence_number'] as number);
    expect(sequence).toEqual([...sequence].sort((left, right) => left - right));
    expect(turn.some((message) => message['type'] === undefined)).toBe(false);
    expect(adapter.calls[0]?.request.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
  });

  it('processes response.create messages one at a time in arrival order', async () => {
    const adapter = createScriptedAdapter({
      calls: [{ ...textCall('first'), gate: { name: 'first', afterEvents: 1 } }, textCall('second')],
    });
    const harness = await startGateway({ adapters: { primary: adapter } });
    const client = await connectUnix(harness);
    client.send(create({ input: 'one' }));
    client.send(create({ input: 'two' }));
    await waitFor(() => adapter.calls.length === 1, { description: 'first call started' });
    expect(adapter.calls).toHaveLength(1);
    adapter.release('first');
    const first = await client.untilTerminal();
    const second = await client.untilTerminal();
    expect(JSON.stringify(first)).toContain('first');
    expect(JSON.stringify(second)).toContain('second');
    expect(adapter.calls).toHaveLength(2);
  });

  it('continues a store:false response from the connection-local state and not from another connection', async () => {
    const adapter = createScriptedAdapter({ calls: [textCall('one'), textCall('two'), textCall('three')] });
    const harness = await startGateway({ adapters: { primary: adapter } });
    const client = await connectUnix(harness);
    client.send(create());
    const first = (await client.untilTerminal()).at(-1) as Message;
    client.send(create({ previous_response_id: first['response'].id, input: 'next' }));
    const second = await client.untilTerminal();
    expect(second.at(-1)?.['type']).toBe('response.completed');
    const replayed = adapter.calls[1]?.request.input ?? [];
    expect(replayed).toHaveLength(3);
    expect(JSON.stringify(replayed[0])).toContain('hi');
    expect(JSON.stringify(replayed[1])).toContain('one');

    const other = await connectUnix(harness);
    other.send(create({ previous_response_id: (second.at(-1) as Message)['response'].id }));
    const missing = (await other.untilTerminal()).at(-1) as Message;
    expect(missing).toMatchObject({ type: 'error', status: 404, error: { code: 'previous_response_not_found', param: 'previous_response_id' } });
    expect(validator.validate('WebSocketErrorEvent', missing).errors).toEqual([]);
  });

  it('keeps only the most recent response for continuation', async () => {
    const adapter = createScriptedAdapter({ calls: [textCall('one'), textCall('two')] });
    const harness = await startGateway({ adapters: { primary: adapter } });
    const client = await connectUnix(harness);
    client.send(create());
    const first = (await client.untilTerminal()).at(-1) as Message;
    client.send(create());
    await client.untilTerminal();
    client.send(create({ previous_response_id: first['response'].id }));
    const missing = (await client.untilTerminal()).at(-1) as Message;
    expect(missing['error'].code).toBe('previous_response_not_found');
  });

  it('evicts the referenced response when a continuation fails with a 4xx or 5xx', async () => {
    const adapter = createScriptedAdapter({ calls: [textCall('one'), { failure: { status: 400, message: 'bad continuation' } }] });
    const harness = await startGateway({ adapters: { primary: adapter } });
    const client = await connectUnix(harness);
    client.send(create());
    const first = (await client.untilTerminal()).at(-1) as Message;
    const previous = first['response'].id as string;
    client.send(create({ previous_response_id: previous }));
    const failed = (await client.untilTerminal()).at(-1) as Message;
    expect(failed['type']).toBe('error');
    expect(failed['status']).toBe(400);
    client.send(create({ previous_response_id: previous }));
    const retry = (await client.untilTerminal()).at(-1) as Message;
    expect(retry['error'].code).toBe('previous_response_not_found');
  });

  it('continues from a persisted response when store is true', async () => {
    const adapter = createScriptedAdapter({ calls: [textCall('one'), textCall('two')] });
    const harness = await startGateway({ adapters: { primary: adapter } });
    const writer = await connectUnix(harness);
    writer.send(create({ store: true }));
    const first = (await writer.untilTerminal()).at(-1) as Message;
    const reader = await connectUnix(harness);
    reader.send(create({ previous_response_id: first['response'].id }));
    expect((await reader.untilTerminal()).at(-1)?.['type']).toBe('response.completed');
  });

  it.for([
    { name: 'a body that is not JSON', message: 'not json', code: 'invalid_json', param: null },
    { name: 'a wrong event type', message: { type: 'response.cancel', model: 'fast' }, code: 'invalid_event_type', param: 'type' },
    { name: 'a stream field', message: create({ stream: true }), code: 'invalid_body', param: 'stream' },
    { name: 'a stream_options field', message: create({ stream_options: { include_usage: true } }), code: 'invalid_body', param: 'stream_options' },
    { name: 'a background field', message: create({ background: false }), code: 'invalid_body', param: 'background' },
    { name: 'an unknown model', message: create({ model: 'nope' }), code: 'model_not_found', param: 'model' },
  ])('answers $name with an error envelope and keeps the connection usable', async ({ message, code, param }) => {
    const adapter = createScriptedAdapter({ calls: [textCall('fine')] });
    const harness = await startGateway({ adapters: { primary: adapter } });
    const client = await connectUnix(harness);
    if (typeof message === 'string') client.socket.send(message);
    else client.send(message);
    const rejected = (await client.untilTerminal()).at(-1) as Message;
    expect(rejected).toMatchObject({ type: 'error', error: { code, param } });
    expect(validator.validate('WebSocketErrorEvent', rejected).errors).toEqual([]);
    client.send(create());
    expect((await client.untilTerminal()).at(-1)?.['type']).toBe('response.completed');
  });

  it.for([
    { name: 'a short message that is the bare credential', sent: TEST_API_KEY },
    { name: 'a long message with the credential at the failing position', sent: `{"a":1,"padding":"${'p'.repeat(200)}","key":${TEST_API_KEY}}` },
  ])('answers $name with invalid_json and a message that quotes nothing of it', async ({ sent }) => {
    const adapter = createScriptedAdapter({ calls: [] });
    const harness = await startGateway({ adapters: { primary: adapter }, credentials: [TEST_API_KEY] });
    const client = await connectUnix(harness);
    client.socket.send(sent);
    const rejected = (await client.untilTerminal()).at(-1) as Message;
    expect(rejected).toMatchObject({ type: 'error', error: { code: 'invalid_json', param: null, message: 'the WebSocket message is not valid JSON' } });
    expectNoCredential(JSON.stringify(rejected), TEST_API_KEY);
  });

  it('redacts a credential that the validator quotes as an unknown item type', async () => {
    const adapter = createScriptedAdapter({ calls: [] });
    const harness = await startGateway({ adapters: { primary: adapter }, credentials: [TEST_API_KEY] });
    const client = await connectUnix(harness);
    client.send(create({ input: [{ type: TEST_API_KEY }] }));
    const rejected = (await client.untilTerminal()).at(-1) as Message;
    expect(rejected).toEqual({ type: 'error', status: 400, error: { type: 'invalid_request', code: 'invalid_body', message: `input[0].type has unknown item type "${REDACTED}"`, param: 'input[0].type' } });
    expectRedacted(JSON.stringify(rejected), TEST_API_KEY);
  });

  it('reports a failed upstream response as a response.failed event, not an error envelope', async () => {
    const events = textResponseEvents({ model: 'scripted-primary', chunks: ['partial'] });
    const adapter = createScriptedAdapter({ calls: [{ events: events.slice(0, 5), failure: { status: 503, message: 'reset' } }] });
    const harness = await startGateway({ adapters: { primary: adapter } });
    const client = await connectUnix(harness);
    client.send(create());
    const turn = await client.untilTerminal();
    expect(turn.at(-1)).toMatchObject({ type: 'response.failed' });
  });

  it('sends websocket_connection_limit_reached and closes when the connection reaches its time limit', async () => {
    const harness = await startGateway({ adapters: { primary: createScriptedAdapter({ calls: [] }) }, config: { websocketConnectionMs: CONNECTION_LIMIT_MS } });
    const client = await connectUnix(harness);
    await waitFor(() => harness.timers.pending().some((timer) => timer.delayMs === CONNECTION_LIMIT_MS), { description: 'connection limit timer armed' });
    harness.timers.advance(CONNECTION_LIMIT_MS);
    const limit = (await client.untilTerminal()).at(-1) as Message;
    expect(limit).toMatchObject({ type: 'error', error: { code: 'websocket_connection_limit_reached' } });
    expect(validator.validate('WebSocketErrorEvent', limit).errors).toEqual([]);
    expect(await client.closed).toBe(1000);
  });

  it('ends an in-flight turn with the limit error envelope as its terminal message when the connection reaches its time limit', async () => {
    const adapter = createScriptedAdapter({ calls: [{ ...textCall('never'), gate: { name: 'held', afterEvents: 1 } }] });
    const harness = await startGateway({ adapters: { primary: adapter }, config: { websocketConnectionMs: CONNECTION_LIMIT_MS } });
    const client = await connectUnix(harness);
    client.send(create());
    await waitFor(() => adapter.calls.length === 1, { description: 'call started' });
    harness.timers.advance(CONNECTION_LIMIT_MS);
    const turn = await client.untilTerminal();
    expect(turn.at(-1)).toMatchObject({ type: 'error', error: { code: 'websocket_connection_limit_reached' } });
    expect(turn.map((message) => message['type'])).not.toContain('response.completed');
    expect(await client.closed).toBe(1000);
  });

  it('applies the momonga-deadline-ms of the upgrade request to every turn, ending a turn held before output with an error', async () => {
    const adapter = createScriptedAdapter({ calls: [{ ...textCall('never'), gate: { name: 'held', afterEvents: 1 } }] });
    const harness = await startGateway({ adapters: { primary: adapter } });
    const client = await open(`ws+unix://${harness.socketPath}:/v1/responses`, { 'momonga-deadline-ms': '2000' });
    client.send(create());
    await waitFor(() => adapter.calls.length === 1, { description: 'call started' });
    harness.timers.advance(2000);
    const turn = await client.untilTerminal();
    expect(turn.map((message) => message['type'])).toEqual(['error']);
    expect(turn.at(-1)).toMatchObject({ type: 'error', error: { code: 'deadline_exceeded' } });
  });

  it('carries the deferral in the WebSocket error envelope when the only target asks for longer than the whole budget', async () => {
    const adapter = createScriptedAdapter({ calls: [{ failure: { status: 429, message: 'come back later', retryAfterMs: 100_000 } }] });
    const harness = await startGateway({ adapters: { primary: adapter } });
    const client = await connectUnix(harness);
    client.send(create());
    const turn = await client.untilTerminal();
    expect(turn.at(-1)).toMatchObject({ type: 'error', status: 429, retry_after_ms: 100_000, deferred: true, error: { code: 'rate_limited' } });
    expect(adapter.calls).toHaveLength(1);
  });

  it('closes idle connections with going-away when the gateway closes and waits for none', async () => {
    const harness = await startGateway({ adapters: { primary: createScriptedAdapter({ calls: [] }) } });
    const client = await connectUnix(harness);
    await harness.gateway.close();
    expect(await client.closed).toBe(1001);
  });

  it('ends an in-flight turn held before output with a gateway_closed error before the connection closes on gateway close', async () => {
    const adapter = createScriptedAdapter({ calls: [{ ...textCall('late'), gate: { name: 'g', afterEvents: 1 } }] });
    const harness = await startGateway({ adapters: { primary: adapter } });
    const client = await connectUnix(harness);
    client.send(create());
    await waitFor(() => adapter.calls.length === 1, { description: 'call started' });
    const closing = harness.gateway.close();
    const turn = await client.untilTerminal();
    expect(turn.map((message) => message['type'])).toEqual(['error']);
    expect(turn.at(-1)).toMatchObject({ type: 'error', error: { code: 'gateway_closed' } });
    await closing;
    expect(await client.closed).toBe(1001);
  });

  it('refuses an upgrade for any other path', async () => {
    const harness = await startGateway({ adapters: { primary: createScriptedAdapter({ calls: [] }) } });
    await expect(open(`ws+unix://${harness.socketPath}:/v1/models`)).rejects.toThrow('HTTP 404');
  });
});

describe('WebSocket transport over the TCP debug listener', () => {
  const connectTcp = (harness: Harness, headers: Record<string, string>): Promise<Client> =>
    open(`ws://127.0.0.1:${harness.gateway.tcpPort}/v1/responses`, headers);

  it('requires the bearer token for the upgrade and then serves the same protocol', async () => {
    const adapter = createScriptedAdapter({ calls: [textCall('over tcp')] });
    const harness = await startGateway({ adapters: { primary: adapter }, debugTcp: { host: '127.0.0.1', port: 0, token: DEBUG_TOKEN } });
    await expect(connectTcp(harness, {})).rejects.toThrow('HTTP 401');
    await expect(connectTcp(harness, { authorization: 'Bearer wrong-token' })).rejects.toThrow('HTTP 401');
    const client = await connectTcp(harness, { authorization: `Bearer ${DEBUG_TOKEN}` });
    client.send(create());
    expect((await client.untilTerminal()).at(-1)?.['type']).toBe('response.completed');
  });

  it('closes its connections when the gateway closes', async () => {
    const harness = await startGateway({ adapters: { primary: createScriptedAdapter({ calls: [] }) }, debugTcp: { host: '127.0.0.1', port: 0, token: DEBUG_TOKEN } });
    const client = await connectTcp(harness, { authorization: `Bearer ${DEBUG_TOKEN}` });
    await harness.gateway.close();
    expect(await client.closed).toBe(1001);
  });
});
