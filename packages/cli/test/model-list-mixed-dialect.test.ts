import http from 'node:http';
import path from 'node:path';
import { registerCleanup, withTempDir } from '@momonga/testkit';
import type { TestContext } from 'vitest';
import { describe, expect, it } from 'vitest';
import { fixedSocket } from '@momonga/foundation';
import { createGatewayClient } from '../src/client/gateway-client.ts';
import type { GatewayClient } from '../src/client/gateway-client.ts';

const capabilities = (schemaDialect: string | undefined): Record<string, unknown> => ({
  contextWindow: 8192,
  maxOutputTokens: 1024,
  toolCalling: 'native',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: true,
  imageInput: false,
  ...(schemaDialect === undefined ? {} : { schemaDialect }),
  tokenCounting: 'estimated',
  usageReported: true,
  maxConcurrency: 4,
  source: 'probed',
});

const member = (model: string, dialect: string) => ({ model, counter: '1'.repeat(64), billing: 'local', adapter: 'chat-completions', answers: 'model', upstream: model.split('/')[1], capabilities: capabilities(dialect) });

const entry = (id: string, chain: unknown[], listed: Record<string, unknown>) => ({ id, object: 'model', provider: id.split('/')[0], ownName: id.split('/')[1], naming: 'server', billing: 'local', capabilities: listed, state: 'available', chain });

const serve = async (context: TestContext, data: unknown[]): Promise<GatewayClient> => {
  const socketPath = path.join(withTempDir(context), 'g.sock');
  const body = JSON.stringify({ object: 'list', data, start: null, roles: {} });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }).end(body);
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

const MIXED = entry('local/a', [member('local/a', 'json-schema-2020-12'), member('local/b', 'strict-closed')], capabilities(undefined));
const PLAIN = entry('local/c', [member('local/c', 'json-schema-2020-12')], capabilities('json-schema-2020-12'));

describe('a chain with mixed dialects does not hide the model list (cli-commands-C49)', () => {
  it('reads a chain entry whose merged capabilities carry no schemaDialect', async (context) => {
    const client = await serve(context, [MIXED, PLAIN]);
    const list = await client.modelList();
    expect(list.data.map((listed) => listed.id)).toEqual(['local/a', 'local/c']);
    expect(list.data[0]?.capabilities).not.toHaveProperty('schemaDialect');
  });

  it('lists a malformed entry as unreadable with its reason and keeps the others', async (context) => {
    const client = await serve(context, [{ ...PLAIN, id: 'local/bad', capabilities: { ...capabilities('json-schema-2020-12'), contextWindow: 'big' } }, PLAIN]);
    const list = await client.modelList();
    expect(list.data.map((listed) => listed.id)).toEqual(['local/bad', 'local/c']);
    expect(list.data[0]?.capabilities).toMatchObject({ toolCalling: { state: 'unavailable', code: 'model_entry_unreadable', message: expect.stringContaining('capabilities') } });
    expect(list.data[1]?.capabilities).toMatchObject({ contextWindow: 8192 });
  });
});
