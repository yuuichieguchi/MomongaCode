import fs from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import path from 'node:path';
import { execFileSync, spawn } from './child-process.ts';

export type FakeGitHttpsRequest = { readonly method: string; readonly path: string; readonly authorized: boolean };

export type FakeGitHttps = {
  readonly origin: string;
  readonly host: string;
  readonly caFile: string;
  readonly repositoryPath: string;
  readonly requests: readonly FakeGitHttpsRequest[];
  close(): Promise<void>;
};

export type FakeGitHttpsOptions = { readonly root: string; readonly repository: string; readonly username: string; readonly credential: string };

const CERTIFICATE_DAYS = '2';
const CGI_HEADER_END = '\r\n\r\n';
const BACKEND_PATH = '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin';

const certificateOf = (root: string): { key: string; cert: string } => {
  const key = path.join(root, 'tls-key.pem');
  const cert = path.join(root, 'tls-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', CERTIFICATE_DAYS, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  return { key, cert };
};

const bodyOf = async (req: import('node:http').IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const runBackend = (env: Readonly<Record<string, string>>, input: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', ['http-backend'], { env: { ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.once('error', reject);
    child.stdin.once('error', (error: Error) => errors.push(Buffer.from(`stdin: ${error.message}\n`)));
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(output));
      else reject(new Error(`git http-backend exited with ${String(code)}: ${Buffer.concat(errors).toString('utf8')}`));
    });
    child.stdin.end(input);
  });

const sendCgi = (res: import('node:http').ServerResponse, output: Buffer): void => {
  const end = output.indexOf(CGI_HEADER_END);
  if (end < 0) throw new Error('git http-backend answered with no header block');
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of output.subarray(0, end).toString('utf8').split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
    else headers[name] = value;
  }
  res.writeHead(status, headers);
  res.end(output.subarray(end + CGI_HEADER_END.length));
};

export const startFakeGitHttps = async (options: FakeGitHttpsOptions): Promise<FakeGitHttps> => {
  const projectRoot = path.join(options.root, 'git-https');
  const repositoryPath = path.join(projectRoot, options.repository);
  fs.mkdirSync(repositoryPath, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', repositoryPath]);
  execFileSync('git', ['-C', repositoryPath, 'config', 'http.receivepack', 'true']);
  const { key, cert } = certificateOf(options.root);
  const expected = `Basic ${Buffer.from(`${options.username}:${options.credential}`).toString('base64')}`;
  const requests: FakeGitHttpsRequest[] = [];
  const sockets = new Set<Duplex>();
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://localhost');
    const authorized = req.headers['authorization'] === expected;
    requests.push({ method: req.method ?? 'GET', path: url.pathname, authorized });
    if (!authorized) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="fake-git"' });
      res.end();
      return;
    }
    void (async () => {
      const input = await bodyOf(req);
      const output = await runBackend(
        {
          PATH: BACKEND_PATH,
          HOME: options.root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method ?? 'GET',
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          CONTENT_LENGTH: String(input.length),
          HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
          REMOTE_USER: options.username,
          REMOTE_ADDR: '127.0.0.1',
        },
        input,
      );
      sendCgi(res, output);
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `https://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    caFile: cert,
    repositoryPath,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        for (const socket of sockets) socket.destroy();
      }),
  };
};
