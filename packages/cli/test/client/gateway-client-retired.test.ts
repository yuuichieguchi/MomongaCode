import http from 'node:http';
import path from 'node:path';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { GENERATION_RETIRED_CODE } from '@momonga/foundation';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { GatewayAnswerError, createGatewayClient } from '../../src/client/gateway-client.ts';

const RETIRED_MESSAGE = 'This gateway belongs to a replaced generation and takes no new requests. The request was not run; send it again.';

const HEALTH = { ok: true, models: {}, version: '1.0.0', apiVersion: 1, pid: 7, startedAt: '2026-11-11T00:00:00.000Z', state: 'running', activeRequests: 0 };

type Answer = { status: number; body: unknown };

const RETIRED: Answer = { status: 503, body: { error: { type: 'server_error', code: GENERATION_RETIRED_CODE, message: RETIRED_MESSAGE, param: null } } };

const generationAnswering = async (context: TestContext, name: string, answers: Answer[]): Promise<{ socketPath: string; requests: string[]; connections: () => number }> => {
  const socketPath = path.join(withTempDir(context), name);
  const requests: string[] = [];
  let connections = 0;
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const answer = answers.shift() ?? { status: 500, body: { error: 'no answer scripted' } };
    response.writeHead(answer.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer.body));
  });
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  registerCleanup(context, async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { socketPath, requests, connections: () => connections };
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

describe('a CLI gateway call refused with generation_retired is sent once more, on a fresh connection to the current generation', () => {
  it('resends the same call once, through a new connection resolved to the serving generation', async (context) => {
    const retired = await generationAnswering(context, 'old.sock', [RETIRED]);
    const serving = await generationAnswering(context, 'new.sock', [{ status: 200, body: HEALTH }]);
    const { client, dialed } = clientAcross(context, [retired.socketPath, serving.socketPath]);

    expect(await client.health()).toEqual(HEALTH);

    expect(dialed).toEqual([retired.socketPath, serving.socketPath]);
    expect(retired.requests).toEqual(['GET /v1/momonga/health']);
    expect(serving.requests).toEqual(['GET /v1/momonga/health']);
    expect(serving.connections()).toBe(1);
  });

  it('returns a second generation_retired to the caller as the refusal, without a third send', async (context) => {
    const retired = await generationAnswering(context, 'old.sock', [RETIRED]);
    const alsoRetired = await generationAnswering(context, 'new.sock', [RETIRED, { status: 200, body: HEALTH }]);
    const unused = await generationAnswering(context, 'third.sock', [{ status: 200, body: HEALTH }]);
    const { client } = clientAcross(context, [retired.socketPath, alsoRetired.socketPath, unused.socketPath]);

    const failure = await client.health().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GatewayAnswerError);
    expect(failure).toMatchObject({ status: 503, answer: { code: GENERATION_RETIRED_CODE, message: RETIRED_MESSAGE } });
    expect(retired.requests).toHaveLength(1);
    expect(alsoRetired.requests).toHaveLength(1);
    expect(unused.requests).toHaveLength(0);
  });
});
