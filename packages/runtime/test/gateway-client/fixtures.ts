import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect } from 'vitest';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import type { FakeClock, FakeTimers } from '@momonga/testkit';
import { GatewayRequestError, createGatewayClient } from '../../src/gateway-client.ts';
import { fixedSocket } from '@momonga/foundation';

export const START_MS = 1_800_000_000_000;
export const CLIENT_VERSION = '7.7.7';
export const USER_AGENT = `momonga-runtime/${CLIENT_VERSION}`;
export const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

export const registerCleanup = (cleanup: () => void | Promise<void>): void => {
  cleanups.push(cleanup);
};

export const shortDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  fs.chmodSync(dir, 0o700);
  registerCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

export const socketPathIn = (dir: string, name = 's.sock'): string => {
  const socketPath = path.join(dir, name);
  expect(Buffer.byteLength(socketPath)).toBeLessThan(104);
  return socketPath;
};

export type ClientOverrides = Partial<Omit<Parameters<typeof createGatewayClient>[0], 'socketPath' | 'clock' | 'version'>>;

export type SpiedTimers = FakeTimers & {
  armed(): number;
  untilArmed(count: number): Promise<void>;
};

export const spiedTimers = (clock: FakeClock): SpiedTimers => {
  const timers = createFakeTimers(clock);
  let armed = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  return {
    ...timers,
    setTimeout: (callback, ms) => {
      const handle = timers.setTimeout(callback, ms);
      armed += 1;
      for (const waiter of waiters.splice(0)) {
        if (armed >= waiter.count) waiter.resolve();
        else waiters.push(waiter);
      }
      return handle;
    },
    armed: () => armed,
    untilArmed: (count) =>
      armed >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ count, resolve });
          }),
  };
};

export const makeClient = (socketPath: string, clock: FakeClock, overrides: ClientOverrides = {}) => {
  const client = createGatewayClient({ resolveSocket: fixedSocket(socketPath), clock, timers: createFakeTimers(clock), version: CLIENT_VERSION, ...overrides });
  registerCleanup(() => client.destroy());
  return client;
};

export const fakeClock = (): FakeClock => createFakeClock(START_MS);

export const userInput = (text: string) => [
  { type: 'message' as const, role: 'user' as const, content: [{ type: 'input_text' as const, text }] },
];

export const streamBody = (model = 'default') => ({ model, input: userInput('hi'), stream: true as const });

export const callOptions = (clock: FakeClock, overrides: { idempotencyKey?: string; deadlineInMs?: number; signal?: AbortSignal; traceparent?: string } = {}) => ({
  idempotencyKey: overrides.idempotencyKey ?? 'key-1',
  deadlineAt: clock.now() + (overrides.deadlineInMs ?? 60_000),
  signal: overrides.signal ?? new AbortController().signal,
  ...(overrides.traceparent === undefined ? {} : { traceparent: overrides.traceparent }),
});

export const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const seen: T[] = [];
  for await (const event of events) seen.push(event);
  return seen;
};

export const settle = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
};

export const expectGatewayError = (error: unknown, expected: Record<string, unknown>): void => {
  expect(error).toBeInstanceOf(GatewayRequestError);
  expect(error).toMatchObject(expected);
};

export type RecordedHttpRequest = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

export type RawHttpFake = {
  socketPath: string;
  requests: RecordedHttpRequest[];
  closedConnections(): number;
  respond(handler: (request: RecordedHttpRequest, response: http.ServerResponse) => void): void;
};

export const startRawHttpFake = async (): Promise<RawHttpFake> => {
  const socketPath = socketPathIn(shortDir('gc-'));
  const requests: RecordedHttpRequest[] = [];
  const sockets = new Set<net.Socket>();
  let closed = 0;
  let handler: (request: RecordedHttpRequest, response: http.ServerResponse) => void = (_request, response) => {
    response.writeHead(500).end();
  };
  const server = http.createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const recorded = { method: incoming.method ?? '', url: incoming.url ?? '', headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(recorded);
      handler(recorded, response);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      closed += 1;
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
  return {
    socketPath,
    requests,
    closedConnections: () => closed,
    respond: (next) => {
      handler = next;
    },
  };
};

export const sseFrame = (data: { type: string } & Record<string, unknown>): string => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;

export const createdEvent = { type: 'response.created', sequence_number: 0, response: { id: 'resp_1', object: 'response', status: 'in_progress' } };
export const deltaEvent = { type: 'response.output_text.delta', sequence_number: 1, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hello' };
export const completedEvent = { type: 'response.completed', sequence_number: 2, response: { id: 'resp_1', object: 'response', status: 'completed' } };

export const openSse = (response: http.ServerResponse): void => {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  response.flushHeaders();
};
