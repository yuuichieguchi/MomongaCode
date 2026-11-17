import http from 'node:http';
import path from 'node:path';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { createGatewayClient } from '../../src/client/gateway-client.ts';

const serveRetired = async (context: TestContext, socketPath: string): Promise<{ requests: () => number }> => {
  let requests = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requests += 1;
      response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'generation_retired', message: 'this generation is retired' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  registerCleanup(context, async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { requests: () => requests };
};

describe('the gateway client leaves the retiring of a generation to the pool', () => {
  it('sends a request answered generation_retired once, and does not re-send it itself', async (context) => {
    const socketPath = path.join(withTempDir(context), 'g.sock');
    const served = await serveRetired(context, socketPath);
    const client = createGatewayClient({ resolveSocket: async () => socketPath });
    registerCleanup(context, () => client.close());
    await expect(client.health()).rejects.toThrow('this generation is retired');
    expect(served.requests()).toBe(1);
  });
});
