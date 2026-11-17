import http from 'node:http';
import path from 'node:path';
import type { EntryIo } from '@momonga/foundation';
import { GENERATION_RETIRED_CODE } from '@momonga/foundation';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { describe, expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';
import { GatewayAnswerError, createGatewayClient } from '../src/client/gateway-client.ts';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { freshHome } from './fresh-home.ts';
import { NO_HELPER } from './no-helper.ts';

const seen = vi.hoisted(() => ({
  headless: [] as { capabilitiesOf(model: string): Promise<unknown> }[],
  resolvers: [] as { version: string; role: string }[],
  socket: '',
}));

vi.mock('../src/run/headless.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/run/headless.ts')>()),
  runHeadless: async (_ports: unknown, _paths: unknown, options: { capabilitiesOf(model: string): Promise<unknown> }) => {
    seen.headless.push(options);
    return 0;
  },
}));

vi.mock('../src/daemon/generations.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/daemon/generations.ts')>()),
  sessionSocketResolver: (ports: { version: string }, _paths: unknown, role: string) => {
    seen.resolvers.push({ version: ports.version, role });
    return async () => seen.socket;
  },
}));

const RETIRED_MESSAGE = 'This gateway belongs to a replaced generation and takes no new requests. The request was not run; send it again.';

type Answer = { status: number; body: unknown };

const RETIRED: Answer = { status: 503, body: { error: { type: 'server_error', code: GENERATION_RETIRED_CODE, message: RETIRED_MESSAGE, param: null } } };

const HEALTH = { ok: true, models: {}, version: '1.0.0', apiVersion: 1, pid: 7, startedAt: '2026-11-11T00:00:00.000Z', state: 'running', activeRequests: 0 };

const ACCOUNTS = { profiles: [], accounts: [] };

const CAPABILITIES = {
  contextWindow: 8192,
  maxOutputTokens: 1024,
  toolCalling: 'native',
  structuredOutput: 'none',
  streaming: true,
  stopSequences: true,
  imageInput: false,
  schemaDialect: 'openai',
  tokenCounting: 'estimated',
  usageReported: true,
  maxConcurrency: 1,
  source: 'declared',
};

const MODEL_LIST = { object: 'list', data: [{ id: 'local/m', object: 'model', provider: 'local', ownName: 'm', billing: 'local', capabilities: CAPABILITIES, state: 'available', chain: [] }], start: null, roles: {} };

const gatewayAnswering = async (context: TestContext, name: string, answers: Answer[]): Promise<{ socketPath: string; requests: string[] }> => {
  const socketPath = path.join(withTempDir(context), name);
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const answer = answers.shift() ?? { status: 500, body: { error: 'no answer scripted' } };
    response.writeHead(answer.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  registerCleanup(context, () => {
    server.closeAllConnections();
    server.close();
  });
  return { socketPath, requests };
};

const clientAcross = (context: TestContext, sockets: readonly string[]) => {
  const dialed: string[] = [];
  const client = createGatewayClient({
    resolveSocket: async () => {
      const socket = sockets[Math.min(dialed.length, sockets.length - 1)] as string;
      dialed.push(socket);
      return socket;
    },
  });
  registerCleanup(context, () => client.close());
  return { client, dialed };
};

describe('every call of the CLI gateway client is sent once; a retired generation refusal is its answer (the pool drops the connection)', () => {
  it('the health read is sent once and fails with the refusal, without a second dial', async (context) => {
    const retired = await gatewayAnswering(context, 'old.sock', [RETIRED]);
    const { client, dialed } = clientAcross(context, [retired.socketPath]);

    const failure = await client.health().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GatewayAnswerError);
    expect(failure).toMatchObject({ status: 503, answer: { code: GENERATION_RETIRED_CODE, message: RETIRED_MESSAGE } });
    expect(dialed).toEqual([retired.socketPath]);
    expect(retired.requests).toEqual(['GET /v1/momonga/health']);
  });

  it('a plan route that reads and a plan route that writes are each sent once', async (context) => {
    const retired = await gatewayAnswering(context, 'old.sock', [RETIRED, RETIRED]);
    const reading = clientAcross(context, [retired.socketPath]);
    const writing = clientAcross(context, [retired.socketPath]);

    await expect(reading.client.plan.accounts()).rejects.toBeInstanceOf(GatewayAnswerError);
    await expect(writing.client.plan.resetHost()).rejects.toBeInstanceOf(GatewayAnswerError);

    expect(retired.requests).toHaveLength(2);
  });
});

describe('a headless run reads the capabilities of its model from the gateway of the generation its session lives in', () => {
  it('the capability read of --print dials the gateway the session resolver names for this program version, with no current generation published', async (context) => {
    const gateway = await gatewayAnswering(context, 'own.sock', [{ status: 200, body: MODEL_LIST }]);
    seen.socket = gateway.socketPath;
    const entry = async (): Promise<number> => 0;
    const entries: DaemonEntries = { supervise: entry, gateway: entry, runtime: entry };
    const sink = { write: () => true };
    const interrupt = new AbortController().signal;
    const ports = { version: '9.9.9', interrupt, home: freshHome(), env: {}, platform: process.platform, cwd: '/c', stdout: sink, stderr: sink, stdin: { isTerminal: true, bytes: async function* () {} } } as unknown as CliPorts;
    const program = buildProgram(
      {
        ports,
        entries,
        update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
        interrupt,
        helper: NO_HELPER,
        entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
        complete: () => undefined,
      },
      { embedded: true },
    );

    await program.parseAsync(['-p', 'hello'], { from: 'user' });
    const capabilities = await seen.headless[0]?.capabilitiesOf('local/m');

    expect(capabilities).toEqual(CAPABILITIES);
    expect(seen.resolvers).toContainEqual({ version: '9.9.9', role: 'gateway' });
    expect(gateway.requests).toEqual(['GET /v1/momonga/models']);
  });
});
