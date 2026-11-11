import http from 'node:http';
import https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { spawn } from './child-process.ts';

export type FakeGitHttpOptions = {
  projectRoot: string;
  username: string;
  password: string;
  tls?: { certPem: string; keyPem: string; host: string };
};

export type FakeGitHttp = {
  origin: string;
  host: string;
  port: number;
  authorizations: string[];
  refused(): number;
  served(): number;
  close(): Promise<void>;
};

type CgiReply = { status: number; headers: Record<string, string>; body: Buffer };

const readRequest = async (req: http.IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const parseCgi = (output: Buffer): CgiReply => {
  const crlf = output.indexOf('\r\n\r\n');
  const lf = output.indexOf('\n\n');
  const end = crlf >= 0 && (lf < 0 || crlf < lf) ? crlf : lf;
  if (end < 0) throw new Error('git http-backend answered without a header block');
  const separator = end === crlf ? 4 : 2;
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of output.subarray(0, end).toString('latin1').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === 'status') status = Number(value.split(' ')[0]);
    else headers[name] = value;
  }
  return { status, headers, body: output.subarray(end + separator) };
};

const runBackend = (projectRoot: string, username: string, req: http.IncomingMessage, url: URL, body: Buffer): Promise<CgiReply> =>
  new Promise((resolve, reject) => {
    const header = (name: string): string => {
      const value = req.headers[name];
      return typeof value === 'string' ? value : '';
    };
    const child = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: projectRoot,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: req.method ?? 'GET',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.replace(/^\?/, ''),
        CONTENT_TYPE: header('content-type'),
        CONTENT_LENGTH: String(body.length),
        HTTP_CONTENT_ENCODING: header('content-encoding'),
        REMOTE_USER: username,
        REMOTE_ADDR: '127.0.0.1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(parseCgi(Buffer.concat(out)));
      } catch (error) {
        reject(new Error(`${error instanceof Error ? error.message : String(error)}: ${Buffer.concat(err).toString('utf8')}`));
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(body);
  });

export const startFakeGitHttp = async (options: FakeGitHttpOptions): Promise<FakeGitHttp> => {
  const expected = `Basic ${Buffer.from(`${options.username}:${options.password}`, 'utf8').toString('base64')}`;
  const authorizations: string[] = [];
  let refused = 0;
  let served = 0;
  const sockets = new Set<Socket>();
  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const respond = async (): Promise<void> => {
      const body = await readRequest(req);
      const given = req.headers['authorization'];
      if (given !== undefined) authorizations.push(given);
      if (given !== expected) {
        refused += 1;
        res.writeHead(401, { 'www-authenticate': 'Basic realm="fake-git"', 'content-type': 'text/plain' });
        res.end('authentication required');
        return;
      }
      const reply = await runBackend(options.projectRoot, options.username, req, new URL(req.url ?? '/', 'http://localhost'), body);
      served += 1;
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body);
    };
    respond().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error instanceof Error ? error.message : String(error));
    });
  };
  const server = options.tls === undefined ? http.createServer(handler) : https.createServer({ cert: options.tls.certPem, key: options.tls.keyPem }, handler);
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const host = `${options.tls === undefined ? '127.0.0.1' : options.tls.host}:${port}`;
  return {
    origin: `${options.tls === undefined ? 'http' : 'https'}://${host}`,
    host,
    port,
    authorizations,
    refused: () => refused,
    served: () => served,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        for (const socket of sockets) socket.destroy();
      }),
  };
};
