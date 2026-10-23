import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  callOptions,
  collect,
  createdEvent,
  expectGatewayError,
  fakeClock,
  makeClient,
  registerCleanup,
  settle,
  shortDir,
  socketPathIn,
  sseFrame,
  streamBody,
} from './fixtures.ts';

type RawFake = { socketPath: string; received: () => string };

const startRawNetFake = async (onData: (socket: net.Socket, received: string) => void): Promise<RawFake> => {
  const socketPath = socketPathIn(shortDir('gt-'));
  const sockets = new Set<net.Socket>();
  let received = '';
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
      onData(socket, received);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  registerCleanup(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return { socketPath, received: () => received };
};

const staleSocketPath = (): string => {
  const socketPath = socketPathIn(shortDir('gr-'));
  const script = `require('node:net').createServer().listen(${JSON.stringify(socketPath)}, () => process.exit(0))`;
  const result = spawnSync(process.execPath, ['-e', script], { stdio: 'ignore', timeout: 10_000 });
  expect(result.status).toBe(0);
  expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
  return socketPath;
};

const SSE_HEAD = 'HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n';
const chunked = (text: string): string => `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`;

describe('gateway client transport faults', () => {
  it('reports gateway_unavailable, proven not sent, when the socket does not exist', async () => {
    const socketPath = socketPathIn(shortDir('gn-'), 'missing.sock');
    const clock = fakeClock();
    const client = makeClient(socketPath, clock);

    const error = await settle(collect(client.stream(streamBody(), callOptions(clock))));

    expectGatewayError(error, { status: 0, type: 'transport', code: 'gateway_unavailable', provenNotSent: true });
  });

  it('reports gateway_unavailable, proven not sent, when the connection is refused', async () => {
    const socketPath = staleSocketPath();
    const clock = fakeClock();
    const client = makeClient(socketPath, clock);

    const error = await settle(client.health());

    expectGatewayError(error, { status: 0, type: 'transport', code: 'gateway_unavailable', provenNotSent: true });
  });

  it('reports gateway_unavailable, not proven unsent, when the connection resets after the request was written', async () => {
    const fake = await startRawNetFake((socket, received) => {
      if (received.includes('\r\n\r\n')) socket.destroy();
    });
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);

    const error = await settle(collect(client.stream(streamBody(), callOptions(clock))));

    expect(fake.received()).toContain('POST /v1/responses');
    expectGatewayError(error, { status: 0, type: 'transport', code: 'gateway_unavailable', provenNotSent: false });
  });

  it('reports stream_interrupted when the connection resets mid-stream', async () => {
    let answered = false;
    const fake = await startRawNetFake((socket) => {
      if (answered) return;
      answered = true;
      socket.write(SSE_HEAD + chunked(sseFrame(createdEvent)), () => {
        setTimeout(() => socket.destroy(), 20);
      });
    });
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);
    const seen: unknown[] = [];

    const error = await settle(
      (async () => {
        for await (const event of client.stream(streamBody(), callOptions(clock))) seen.push(event);
      })(),
    );

    expect(seen).toEqual([createdEvent]);
    expectGatewayError(error, { status: 0, type: 'transport', code: 'stream_interrupted' });
  });

  it('reports stream_interrupted when the server closes mid-stream without a terminal chunk', async () => {
    let answered = false;
    const fake = await startRawNetFake((socket) => {
      if (answered) return;
      answered = true;
      socket.end(SSE_HEAD + chunked(sseFrame(createdEvent)));
    });
    const clock = fakeClock();
    const client = makeClient(fake.socketPath, clock);
    const seen: unknown[] = [];

    const error = await settle(
      (async () => {
        for await (const event of client.stream(streamBody(), callOptions(clock))) seen.push(event);
      })(),
    );

    expect(seen).toEqual([createdEvent]);
    expectGatewayError(error, { status: 0, type: 'transport', code: 'stream_interrupted' });
  });
});
