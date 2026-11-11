import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export type FakeSseFrame = { event?: string; data: unknown };

export type FakeUpstreamReply =
  | { kind: 'stream'; frames: FakeSseFrame[]; trailer?: 'end' | 'reset'; headers?: Record<string, string> }
  | { kind: 'json'; body: unknown }
  | { kind: 'error'; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: 'hang'; frames?: FakeSseFrame[] };

export type RecordedUpstreamRequest = {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
};

export type FakeUpstreamOptions = {
  path: string;
  extraPaths?: readonly string[];
  validate?: (request: RecordedUpstreamRequest) => FakeUpstreamReply | undefined;
  script?: FakeUpstreamReply[];
  respond?: (request: RecordedUpstreamRequest) => FakeUpstreamReply | undefined;
  authenticate?: (headers: http.IncomingHttpHeaders) => FakeUpstreamReply | undefined;
  socketPath?: string;
  listedModel?: string;
};

export type FakeUpstreamServer = {
  socketPath: string;
  requests: RecordedUpstreamRequest[];
  disconnects(): number;
  close(): Promise<void>;
};

const readBody = async (request: http.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

const encodeFrame = (frame: FakeSseFrame): string => {
  const data = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
  return `${frame.event === undefined ? '' : `event: ${frame.event}\n`}data: ${data}\n\n`;
};

const write = (response: http.ServerResponse, chunk: string): Promise<void> =>
  new Promise((resolve, reject) => {
    response.write(chunk, (error) => (error === null || error === undefined ? resolve() : reject(error)));
  });

const startStream = async (response: http.ServerResponse, frames: readonly FakeSseFrame[], headers: Record<string, string> = {}): Promise<void> => {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers });
  for (const frame of frames) await write(response, encodeFrame(frame));
};

const serve = async (reply: FakeUpstreamReply, response: http.ServerResponse): Promise<void> => {
  if (reply.kind === 'json') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply.body));
    return;
  }
  if (reply.kind === 'error') {
    response.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
    response.end(JSON.stringify(reply.body));
    return;
  }
  await startStream(response, reply.frames ?? [], reply.kind === 'stream' ? reply.headers : undefined);
  if (reply.kind === 'hang') {
    await new Promise<void>((resolve) => response.once('close', () => resolve()));
    return;
  }
  if (reply.trailer === 'reset') {
    response.destroy();
    return;
  }
  response.end();
};

export const serveFakeUpstreamReply = serve;

const MODEL_LISTING_PATH = '/v1/models';

export const startFakeSseUpstream = async (options: FakeUpstreamOptions): Promise<FakeUpstreamServer> => {
  const requests: RecordedUpstreamRequest[] = [];
  const script = [...(options.script ?? [])];
  let disconnectCount = 0;

  const server = http.createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request);
      let body: unknown = raw;
      if (raw !== '') {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      if (options.listedModel !== undefined && request.method === 'GET' && request.url === MODEL_LISTING_PATH) {
        await serve({ kind: 'json', body: { object: 'list', data: [{ id: options.listedModel, object: 'model' }] } }, response);
        return;
      }
      const recorded: RecordedUpstreamRequest = { method: request.method ?? 'GET', path: request.url ?? '/', headers: request.headers, body };
      requests.push(recorded);
      response.once('close', () => {
        if (!response.writableFinished) disconnectCount += 1;
      });
      if (recorded.method !== 'POST' || (recorded.path !== options.path && !(options.extraPaths ?? []).includes(recorded.path))) {
        await serve({ kind: 'error', status: 404, body: { error: { message: `no route for ${recorded.method} ${recorded.path}` } } }, response);
        return;
      }
      const rejected = options.authenticate?.(request.headers);
      if (rejected !== undefined) {
        await serve(rejected, response);
        return;
      }
      const invalid = options.validate?.(recorded);
      if (invalid !== undefined) {
        await serve(invalid, response);
        return;
      }
      const reply = options.respond === undefined ? script.shift() : options.respond(recorded);
      if (reply === undefined) {
        await serve({ kind: 'error', status: 500, body: { error: { message: 'the fake upstream has no scripted reply left' } } }, response);
        return;
      }
      await serve(reply, response);
    })();
  });

  const sockets = new Set<net.Socket>();
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  let ownedDir: string | undefined;
  let socketPath = options.socketPath;
  if (socketPath === undefined) {
    ownedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'));
    fs.chmodSync(ownedDir, 0o700);
    socketPath = path.join(ownedDir, 'fake.sock');
  }
  const listening = socketPath;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listening, () => {
      server.off('error', reject);
      resolve();
    });
  });

  let closed = false;
  return {
    socketPath: listening,
    requests,
    disconnects: () => disconnectCount,
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (ownedDir !== undefined) fs.rmSync(ownedDir, { recursive: true, force: true });
    },
  };
};
