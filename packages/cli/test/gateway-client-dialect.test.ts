import http from 'node:http';
import path from 'node:path';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { createGatewayClient } from '../src/client/gateway-client.ts';
import type { GatewayClient } from '../src/client/gateway-client.ts';

const capabilities = (schemaDialect: unknown): Record<string, unknown> => ({
  contextWindow: 8192,
  maxOutputTokens: 1024,
  toolCalling: 'native',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: true,
  imageInput: false,
  schemaDialect,
  tokenCounting: 'estimated',
  usageReported: true,
  maxConcurrency: 4,
  source: 'probed',
});

const serveModels = async (context: TestContext, schemaDialect: unknown): Promise<GatewayClient> => {
  const socketPath = path.join(withTempDir(context), 'g.sock');
  const body = JSON.stringify({ data: [{ id: 'default', targets: ['local'], capabilities: capabilities(schemaDialect) }] });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const client = createGatewayClient({ socketPath });
  registerCleanup(context, async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return client;
};

describe('the gateway client reads a dialect id as an open string', () => {
  it.for(['json-schema-2020-12', 'explicit-keys', 'strict-closed', 'inlined-subset', 'ordered-subset'])('accepts the dialect id %s', async (id, context) => {
    const client = await serveModels(context, id);
    expect(await client.capabilitiesOf('default')).toMatchObject({ schemaDialect: id });
  });

  it.for([
    ['an empty string', ''],
    ['a number', 7],
    ['an absent value', undefined],
  ] as const)('refuses a model list whose dialect is %s', async ([_label, value], context) => {
    const client = await serveModels(context, value);
    await expect(client.capabilitiesOf('default')).rejects.toThrow('not a model list');
  });
});
