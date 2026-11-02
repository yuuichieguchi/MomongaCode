import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createScriptedAdapter, textResponseEvents, waitFor } from '@momonga/testkit';
import { getJson, postJson, registerCleanup, sseIterator, startGateway, userInput } from './gateway-helpers.ts';
import { bigTextEvents } from './gateway-support.ts';

const READER_STALL_MS = 30_000;
const CONNECTION_LIMIT_MS = 5000;
const BIG_CHUNKS = 200;
const BIG_CHUNK_BYTES = 100_000;
const QUEUED_MESSAGES = 20;
const QUEUED_MESSAGE_BYTES = 900_000;

const textCall = (text: string) => ({ events: textResponseEvents({ model: 'scripted-primary', chunks: [text] }) });

const create = (extra: Record<string, unknown> = {}) => ({ type: 'response.create', model: 'fast', store: false, input: userInput('hi'), ...extra });

const openSocket = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    registerCleanup(() => socket.terminate());
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });

const rawUpgrade = (socketPath: string, target: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const connection = net.connect(socketPath);
    registerCleanup(() => {
      connection.destroy();
    });
    let received = '';
    connection.on('data', (chunk) => {
      received += chunk.toString('latin1');
    });
    connection.once('error', reject);
    connection.once('close', () => resolve(received));
    connection.write(
      `GET ${target} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  });

describe('WebSocket upgrade request target', () => {
  it.each(['//', '///', '/\\', '//v1/responses'])('refuses the malformed target %s with 404 and keeps serving', async (target) => {
    const harness = await startGateway({ adapters: { primary: createScriptedAdapter({ calls: [] }) } });
    const received = await rawUpgrade(harness.socketPath, target);
    expect(received.startsWith('HTTP/1.1 404')).toBe(true);
    expect((await getJson(harness.client, '/v1/models')).status).toBe(200);
  });
});

describe('a client that stops reading', () => {
  it('releases the target slot of a stalled WebSocket turn once the reader-stall bound passes', async () => {
    const adapter = createScriptedAdapter({ calls: [{ events: bigTextEvents(BIG_CHUNKS, BIG_CHUNK_BYTES) }, textCall('after')] });
    const harness = await startGateway({ adapters: { primary: adapter }, config: { targets: { primary: { model: 'scripted-primary', maxConcurrency: 1 } } } });
    const socket = await openSocket(`ws+unix://${harness.socketPath}:/v1/responses`);
    socket.pause();
    socket.send(JSON.stringify(create()));
    await waitFor(() => harness.timers.pending().some((timer) => timer.delayMs === READER_STALL_MS), { description: 'stalled send armed' });
    harness.timers.advance(READER_STALL_MS);
    const second = await openSocket(`ws+unix://${harness.socketPath}:/v1/responses`);
    const types: string[] = [];
    second.on('message', (data) => types.push(JSON.parse(data.toString()).type as string));
    second.send(JSON.stringify(create()));
    await waitFor(() => types.includes('response.completed'), { description: 'second turn completed' });
    expect(adapter.calls).toHaveLength(2);
  });

  it('releases the target slot of a stalled unkeyed SSE stream once the reader-stall bound passes', async () => {
    const adapter = createScriptedAdapter({ calls: [{ events: bigTextEvents(BIG_CHUNKS, BIG_CHUNK_BYTES) }, textCall('after')] });
    const harness = await startGateway({ adapters: { primary: adapter }, config: { targets: { primary: { model: 'scripted-primary', maxConcurrency: 1 } } } });
    const first = sseIterator(await postJson(harness.client, '/v1/responses', { model: 'fast', input: userInput('hi'), stream: true }));
    await first.next();
    harness.timers.advance(READER_STALL_MS);
    const second = sseIterator(await postJson(harness.client, '/v1/responses', { model: 'fast', input: userInput('hi'), stream: true }));
    const types: string[] = [];
    for (let step = await second.next(); step.done !== true; step = await second.next()) types.push(step.value.data.type as string);
    expect(types).toContain('response.completed');
    expect(adapter.calls).toHaveLength(2);
  });
});

describe('WebSocket connection limit', () => {
  it('reports a failed final send through onError instead of an unhandled rejection', async () => {
    const adapter = createScriptedAdapter({ calls: [{ events: bigTextEvents(BIG_CHUNKS, BIG_CHUNK_BYTES) }] });
    const errors: unknown[] = [];
    const harness = await startGateway({
      adapters: { primary: adapter },
      config: { websocketConnectionMs: CONNECTION_LIMIT_MS },
      onError: (error) => errors.push(error),
    });
    const socket = await openSocket(`ws+unix://${harness.socketPath}:/v1/responses`);
    socket.pause();
    socket.send(JSON.stringify(create()));
    await waitFor(() => harness.timers.pending().some((timer) => timer.delayMs === READER_STALL_MS), { description: 'stalled send armed' });
    harness.timers.advance(CONNECTION_LIMIT_MS);
    socket.terminate();
    await waitFor(() => errors.length > 0, { description: 'final send failure reported' });
    expect(errors[0]).toBeInstanceOf(Error);
  });
});

describe('WebSocket message queue', () => {
  it('pauses the socket once queued messages reach the body limit and resumes it when the queue drains', async () => {
    const pause = vi.spyOn(WebSocket.prototype, 'pause');
    const resume = vi.spyOn(WebSocket.prototype, 'resume');
    registerCleanup(() => {
      pause.mockRestore();
      resume.mockRestore();
    });
    const adapter = createScriptedAdapter({ calls: [{ ...textCall('held'), gate: { name: 'held', afterEvents: 1 } }, textCall('next')] });
    const harness = await startGateway({ adapters: { primary: adapter } });
    const socket = await openSocket(`ws+unix://${harness.socketPath}:/v1/responses`);
    socket.send(JSON.stringify(create()));
    await waitFor(() => adapter.calls.length === 1, { description: 'turn started' });
    const padding = 'x'.repeat(QUEUED_MESSAGE_BYTES);
    for (let index = 0; index < QUEUED_MESSAGES; index += 1) socket.send(JSON.stringify(create({ metadata: { padding } })));
    await waitFor(() => pause.mock.calls.length > 0, { description: 'socket paused' });
    expect(resume.mock.calls).toHaveLength(0);
    adapter.release('held');
    await waitFor(() => resume.mock.calls.length > 0, { description: 'socket resumed' });
  });
});
