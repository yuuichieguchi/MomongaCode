import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOpenResponsesAdapter } from '@momonga/gateway';
import type { UpstreamEndpoint, UpstreamLiveness } from '@momonga/gateway';
import { createFakeClock, createFakeTimers, driveFakeTime, openResponsesTextReply } from '@momonga/testkit';
import { START_MS, postJson, readJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';
import { UNCONFIGURED_NETWORK } from '@momonga/testkit';

const BOUND_MS = 50;
const UNDICI_TIMEOUT_TICK_MS = 1000;
const PAST_THE_BOUND_MS = BOUND_MS + 3 * UNDICI_TIMEOUT_TICK_MS;
const KEEPALIVE_EVERY_MS = BOUND_MS / 5;
const ANSWER_TEXT = 'answered after a long silence';
const SSE_HEADERS = { 'content-type': 'text/event-stream' };

type Transport = 'tcp' | 'unix';
type UpstreamStep = 'silentBeforeHeaders' | 'silentAfterHeaders' | 'lateHeaders' | 'lateBodyAfterHeaders' | 'commentsPastTheBound' | 'answerAtOnce' | 'closeConnection';

const encodedAnswer = (): string => {
  const reply = openResponsesTextReply([ANSWER_TEXT]);
  if (reply.kind !== 'stream') throw new Error('the text reply must be a stream');
  return reply.frames
    .map((frame) => {
      const data = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
      return `${frame.event === undefined ? '' : `event: ${frame.event}\n`}data: ${data}\n\n`;
    })
    .join('');
};

const play = (step: UpstreamStep, request: http.IncomingMessage, response: http.ServerResponse): void => {
  switch (step) {
    case 'silentBeforeHeaders':
      return;
    case 'silentAfterHeaders':
      response.writeHead(200, SSE_HEADERS);
      response.flushHeaders();
      return;
    case 'closeConnection':
      request.socket.destroy();
      return;
    case 'answerAtOnce':
      response.writeHead(200, SSE_HEADERS);
      response.end(encodedAnswer());
      return;
    case 'lateHeaders':
      setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, SSE_HEADERS);
        response.end(encodedAnswer());
      }, PAST_THE_BOUND_MS);
      return;
    case 'lateBodyAfterHeaders':
      response.writeHead(200, SSE_HEADERS);
      response.flushHeaders();
      setTimeout(() => {
        if (!response.destroyed) response.end(encodedAnswer());
      }, PAST_THE_BOUND_MS);
      return;
    case 'commentsPastTheBound': {
      response.writeHead(200, SSE_HEADERS);
      response.flushHeaders();
      const keepalive = setInterval(() => {
        if (!response.destroyed) response.write(': keepalive\n\n');
      }, KEEPALIVE_EVERY_MS);
      setTimeout(() => {
        clearInterval(keepalive);
        if (!response.destroyed) response.end(encodedAnswer());
      }, PAST_THE_BOUND_MS);
      return;
    }
  }
};

const startUpstream = async (transport: Transport, steps: readonly UpstreamStep[]): Promise<{ endpoint: UpstreamEndpoint; requests: () => number }> => {
  const script = [...steps];
  let received = 0;
  const sockets = new Set<net.Socket>();
  const server = http.createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      received += 1;
      play(script.shift() ?? 'closeConnection', request, response);
    });
  });
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  registerCleanup(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  if (transport === 'unix') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
    const socketPath = path.join(dir, 'upstream.sock');
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    return { endpoint: { kind: 'unix', socketPath }, requests: () => received };
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  return { endpoint: { kind: 'tcp', baseUrl: `http://127.0.0.1:${address.port}/v1`, network: UNCONFIGURED_NETWORK }, requests: () => received };
};

const settingsLiveness = (headersTimeoutMs: number, idleTimeoutMs: number): UpstreamLiveness => ({ headersTimeoutMs, idleTimeoutMs }) as unknown as UpstreamLiveness;

const askThrough = async (transport: Transport, steps: readonly UpstreamStep[], liveness: UpstreamLiveness, maxAttempts = 1) => {
  const upstream = await startUpstream(transport, steps);
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const adapter = createOpenResponsesAdapter({
    resolveEndpoint: async () => upstream.endpoint,
    capabilities: async () => REMOTE_CAPABILITIES,
    clock,
    liveness,
  });
  registerCleanup(() => adapter.close());
  const harness = await startGateway({
    clock,
    timers,
    adapters: { remote: adapter },
    config: {
      aliases: { fast: ['remote'] },
      targets: { remote: { model: 'upstream-model', kind: 'remote' } },
      retry: { maxAttempts, totalWaitMs: maxAttempts === 1 ? 1 : 60_000, baseMs: 1, maxMs: 1 },
    },
  });
  let settled = false;
  const pending = postJson(harness.client, '/v1/responses', { model: 'fast', input: userInput('a long prompt') })
    .then(readJson)
    .finally(() => {
      settled = true;
    });
  await driveFakeTime(timers, { done: () => settled, horizonAt: START_MS + 120_000, description: 'the gateway reply' });
  return { reply: await pending, requests: upstream.requests() };
};

const expectEnded = (reply: Awaited<ReturnType<typeof askThrough>>['reply']): void => {
  expect(reply.status).toBe(502);
  expect(reply.body.error.code).toBe('provider_unavailable');
};

const expectAnswered = (reply: Awaited<ReturnType<typeof askThrough>>['reply']): void => {
  expect(reply.status).toBe(200);
  expect(reply.body.error).toBeNull();
  expect(reply.body.status).toBe('completed');
  expect(JSON.stringify(reply.body.output)).toContain(ANSWER_TEXT);
};

describe.each<Transport>(['tcp', 'unix'])('the upstream liveness bounds from models.headersTimeoutMs and models.idleTimeoutMs over %s', (transport) => {
  it('ends a connected upstream that sends no headers past the headers bound', async () => {
    const { reply } = await askThrough(transport, ['silentBeforeHeaders'], settingsLiveness(BOUND_MS, 0));
    expectEnded(reply);
  });

  it('ends a connected upstream that sends headers and then stays silent past the idle bound', async () => {
    const { reply } = await askThrough(transport, ['silentAfterHeaders'], settingsLiveness(0, BOUND_MS));
    expectEnded(reply);
  });

  it('keeps a stream alive while SSE comments keep arriving within the idle bound, past the bound in total', async () => {
    const { reply } = await askThrough(transport, ['commentsPastTheBound'], settingsLiveness(0, BOUND_MS));
    expectAnswered(reply);
  });

  it('completes a request whose headers arrive late when the headers bound is 0', async () => {
    const { reply } = await askThrough(transport, ['lateHeaders'], settingsLiveness(0, BOUND_MS));
    expectAnswered(reply);
  });

  it('completes a request whose body arrives late after the headers when the idle bound is 0', async () => {
    const { reply } = await askThrough(transport, ['lateBodyAfterHeaders'], settingsLiveness(BOUND_MS, 0));
    expectAnswered(reply);
  });

  it('retries an attempt ended by the headers bound as a gateway failure', async () => {
    const { reply, requests } = await askThrough(transport, ['silentBeforeHeaders', 'answerAtOnce'], settingsLiveness(BOUND_MS, BOUND_MS), 2);
    expectAnswered(reply);
    expect(requests).toBe(2);
  });

  it('retries an attempt ended by the idle bound as a gateway failure', async () => {
    const { reply, requests } = await askThrough(transport, ['silentAfterHeaders', 'answerAtOnce'], settingsLiveness(BOUND_MS, BOUND_MS), 2);
    expectAnswered(reply);
    expect(requests).toBe(2);
  });

  it('fails with the connection error when the upstream closes the connection', async () => {
    const { reply } = await askThrough(transport, ['closeConnection'], settingsLiveness(BOUND_MS, BOUND_MS));
    expectEnded(reply);
  });
});
