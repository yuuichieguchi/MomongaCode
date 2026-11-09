import fs from 'node:fs';
import http from 'node:http';
import { startFakeChatCompletions } from './fake-chat-completions.ts';
import { FAKE_SERVER_KEY_MISSING_EXIT, FAKE_SERVER_MODEL } from './fake-managed-server.ts';
import type { FakeManagedServerConfig } from './fake-managed-server.ts';

const json = (response: http.ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const forward = (request: http.IncomingMessage, response: http.ServerResponse, innerSocket: string): void => {
  const upstream = http.request({ socketPath: innerSocket, method: request.method, path: request.url, headers: request.headers }, (answer) => {
    response.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(response);
  });
  upstream.on('error', () => json(response, 502, { error: { message: 'fake: the inner server failed' } }));
  request.pipe(upstream);
};

const run = async (argv: readonly string[]): Promise<void> => {
  const flag = argv.indexOf('--socket');
  const socketPath = flag < 0 ? undefined : argv[flag + 1];
  if (socketPath === undefined) throw new Error('fake-server run requires --socket <path>');
  const innerSocket = `${socketPath}i`;
  const inner = await startFakeChatCompletions({ scenario: 'tools-ok', socketPath: innerSocket, modelId: FAKE_SERVER_MODEL });
  const front = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/ready') return json(response, 200, { ready: true });
    if (request.method === 'GET' && request.url === '/models') return json(response, 200, { models: [{ name: FAKE_SERVER_MODEL }] });
    if (request.method === 'GET') return json(response, 404, { error: { message: 'fake: no such route' } });
    return forward(request, response, innerSocket);
  });
  await new Promise<void>((resolve) => front.listen(socketPath, () => resolve()));
  process.once('SIGTERM', () => {
    front.close();
    void inner.close().finally(() => process.exit(0));
  });
};

export const runFakeManagedServer = async ({ configPath, argv }: { configPath: string; argv: readonly string[] }): Promise<void> => {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as FakeManagedServerConfig;
  if (config.envDumpFile !== undefined) fs.appendFileSync(config.envDumpFile, `${JSON.stringify({ argv, pid: process.pid })}\n`);
  const [command] = argv;
  if (command === 'run') return run(argv);
  if (command === 'check-env') {
    if (config.keySet === false) {
      process.stderr.write('FAKE_KEY is not set\n');
      process.exitCode = FAKE_SERVER_KEY_MISSING_EXIT;
    }
    return;
  }
  process.stderr.write(`fake-server: unknown command ${JSON.stringify(command)}\n`);
  process.exitCode = 2;
};
