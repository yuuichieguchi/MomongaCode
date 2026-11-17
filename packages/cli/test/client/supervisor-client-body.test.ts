import http from 'node:http';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import { fixedSocket } from '@momonga/foundation';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import { createSupervisorClient } from '../../src/client/supervisor-client.ts';

const serveBody = async (context: TestContext, body: string): Promise<string> => {
  const socketPath = path.join(withTempDir(context), 's.sock');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  registerCleanup(context, async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return socketPath;
};

describe('the supervisor client error for a 2xx body that is not a health answer', () => {
  it('does not print the body text', async (context: TestContext) => {
    const longText = JSON.stringify({ note: "secret-payload ".repeat(40) });
    const socketPath = await serveBody(context, longText);
    const client = createSupervisorClient({ resolveSocket: fixedSocket(socketPath) });
    registerCleanup(context, () => client.close());
    const failure = await client.health().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('GET /v1/health answered a body that is not a supervisor health');
  });
});
