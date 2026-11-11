import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { GENERATION_RETIRED_CODE, momongaPaths, publishCurrentGeneration } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { describe, expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';
import { runAuthResetHost } from '../src/commands/auth-wiring.ts';
import type { CliPorts } from '../src/ports.ts';
import { CHATGPT } from './fake-plan-gateway.tsx';
import { freshHome } from './fresh-home.ts';

vi.mock('../src/daemon/ensure-daemon.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/daemon/ensure-daemon.ts')>()),
  ensureCurrentDaemon: async () => ({}),
}));

type Answer = { status: number; body: unknown };

const RETIRED: Answer = {
  status: 503,
  body: { error: { type: 'server_error', code: GENERATION_RETIRED_CODE, message: 'This gateway belongs to a replaced generation and takes no new requests. The request was not run; send it again.', param: null } },
};

const gateway = async (context: TestContext, name: string, answerOf: (request: string) => Promise<Answer>): Promise<{ socketPath: string; requests: string[] }> => {
  const socketPath = path.join(withTempDir(context), name);
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    const line = `${request.method} ${request.url}`;
    requests.push(line);
    request.resume();
    void answerOf(line).then((answer) => {
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  registerCleanup(context, () => {
    server.closeAllConnections();
    server.close();
  });
  return { socketPath, requests };
};

const publish = async (paths: MomongaPaths, generation: number, gatewaySocket: string): Promise<void> => {
  expect(await publishCurrentGeneration(paths, { generation, version: '1.0.0', sockets: { gateway: gatewaySocket, runtime: `${gatewaySocket}.runtime`, supervisor: `${gatewaySocket}.supervisor` } })).toBe('published');
};

describe('the auth commands reach the gateway of the current generation (gateway-accounts C44, P-242)', () => {
  it('auth reset-host that meets a generation retired under it resolves the current generation again, and every later request of the command goes to the gateway that serves now', async (context) => {
    const paths = momongaPaths(freshHome());
    fs.mkdirSync(path.dirname(paths.generationLock), { recursive: true });
    fs.mkdirSync(path.dirname(paths.current), { recursive: true });
    const serving = await gateway(context, 'second.sock', async (request) =>
      request.startsWith('GET ') ? { status: 200, body: { profiles: [CHATGPT], accounts: [] } } : { status: 200, body: { hostId: 'host-2' } },
    );
    const retired = await gateway(context, 'first.sock', async () => {
      await publish(paths, 2, serving.socketPath);
      return RETIRED;
    });
    await publish(paths, 1, retired.socketPath);
    const written: string[] = [];
    const ports = { stdout: { write: (text: string) => void written.push(text) }, stderr: { write: () => undefined }, terminal: undefined } as unknown as CliPorts;
    expect(await runAuthResetHost(ports, paths, true, new AbortController().signal)).toBe(0);
    expect(retired.requests).toEqual(['GET /v1/momonga/plan/accounts']);
    expect(serving.requests).toEqual(['GET /v1/momonga/plan/accounts', 'POST /v1/momonga/plan/host/reset']);
    expect(written.join('')).toContain('This computer is now the host host-2');
  });
});
