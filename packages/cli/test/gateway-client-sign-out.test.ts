import http from 'node:http';
import path from 'node:path';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { fixedSocket } from '@momonga/foundation';
import { createGatewayClient } from '../src/client/gateway-client.ts';
import type { GatewayClient } from '../src/client/gateway-client.ts';

const USAGE_URL = 'https://chatgpt.com/settings/usage';

const WORK = { profile: 'chatgpt', account: 'work' };

const serveSignOut = async (context: TestContext, answer: unknown): Promise<GatewayClient> => {
  const socketPath = path.join(withTempDir(context), 'g.sock');
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const client = createGatewayClient({ resolveSocket: fixedSocket(socketPath) });
  registerCleanup(context, async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return client;
};

describe('the gateway client reads a sign-out report with exactly the three revocation values', () => {
  it.for(['confirmed', 'unconfirmed', 'none'])('accepts the revocation %s', async (revocation, context) => {
    const client = await serveSignOut(context, { revocation, usageUrl: USAGE_URL });
    expect(await client.plan.signOut(WORK)).toEqual({ revocation, usageUrl: USAGE_URL });
  });

  it.for([
    ['another word', 'revoked'],
    ['a boolean', true],
    ['an absent value', undefined],
  ] as const)('refuses a sign-out report whose revocation is %s', async ([_label, revocation], context) => {
    const client = await serveSignOut(context, { revocation, usageUrl: USAGE_URL });
    await expect(client.plan.signOut(WORK)).rejects.toThrow('not a sign-out report');
  });
});
