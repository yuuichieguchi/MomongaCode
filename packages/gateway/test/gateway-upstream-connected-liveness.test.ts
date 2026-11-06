import http from 'node:http';
import type net from 'node:net';
import { describe, expect, it } from 'vitest';
import { createOpenResponsesAdapter } from '@momonga/gateway';
import type { UpstreamLiveness } from '@momonga/gateway';
import { createFakeClock, openResponsesTextReply } from '@momonga/testkit';
import { START_MS, postJson, readJson, registerCleanup, startGateway, userInput } from './gateway-helpers.ts';
import { REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';

const LIVENESS: UpstreamLiveness = { headersTimeoutMs: 50, bodyTimeoutMs: 50 };
const UNDICI_TIMEOUT_TICK_MS = 1000;
const ANSWER_AFTER_MS = Math.max(LIVENESS.headersTimeoutMs, LIVENESS.bodyTimeoutMs) + 3 * UNDICI_TIMEOUT_TICK_MS;
const ANSWER_TEXT = 'answered after a long silence';

type UpstreamBehaviour = 'answerAfterBound' | 'closeConnection';

const encodeSse = (): string => {
  const reply = openResponsesTextReply([ANSWER_TEXT]);
  if (reply.kind !== 'stream') throw new Error('the text reply must be a stream');
  return reply.frames
    .map((frame) => {
      const data = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
      return `${frame.event === undefined ? '' : `event: ${frame.event}\n`}data: ${data}\n\n`;
    })
    .join('');
};

const startLoopbackUpstream = async (behaviour: UpstreamBehaviour): Promise<string> => {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      if (behaviour === 'closeConnection') {
        request.socket.destroy();
        return;
      }
      setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(encodeSse());
      }, ANSWER_AFTER_MS);
    });
  });
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  registerCleanup(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  const address = server.address() as net.AddressInfo;
  return `http://127.0.0.1:${address.port}/v1`;
};

const startGatewayOver = async (behaviour: UpstreamBehaviour) => {
  const baseUrl = await startLoopbackUpstream(behaviour);
  const adapter = createOpenResponsesAdapter({
    resolveEndpoint: async () => ({ kind: 'tcp', baseUrl }),
    capabilities: async () => REMOTE_CAPABILITIES,
    clock: createFakeClock(START_MS),
    liveness: LIVENESS,
  });
  registerCleanup(() => adapter.close());
  return startGateway({
    adapters: { remote: adapter },
    config: { aliases: { fast: ['remote'] }, targets: { remote: { model: 'upstream-model', kind: 'remote' } }, retry: { maxAttempts: 1, totalWaitMs: 1 } },
  });
};

describe('a request to an upstream that is still connected', () => {
  it('is not ended by a private wall-clock bound and completes when the upstream answers', async () => {
    const harness = await startGatewayOver('answerAfterBound');
    const reply = await readJson(await postJson(harness.client, '/v1/responses', { model: 'fast', input: userInput('a long prompt') }));
    expect(reply.status).toBe(200);
    expect(reply.body.error).toBeNull();
    expect(reply.body.status).toBe('completed');
    expect(JSON.stringify(reply.body.output)).toContain(ANSWER_TEXT);
  });

  it('fails with the connection error when the upstream closes the connection', async () => {
    const harness = await startGatewayOver('closeConnection');
    const reply = await readJson(await postJson(harness.client, '/v1/responses', { model: 'fast', input: userInput('a long prompt') }));
    expect(reply.status).toBe(502);
    expect(reply.body.error.code).toBe('provider_unavailable');
  });
});
