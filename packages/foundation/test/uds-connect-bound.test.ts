import { describe, expect, it, vi } from 'vitest';
import type { buildConnector as BuildConnector } from 'undici';

const connectorOptions: unknown[] = [];

vi.mock('undici', async (original) => {
  const actual = await original<typeof import('undici')>();
  return {
    ...actual,
    buildConnector: (options: BuildConnector.BuildOptions) => {
      connectorOptions.push(options);
      return actual.buildConnector(options);
    },
  };
});

const { createUdsClient, fixedSocket } = await import('../src/uds.ts');

describe('C14: the connect bound of a local client is its owner\'s, never the library default', () => {
  for (const connectTimeoutMs of [0, 250]) {
    it(`connects with the bound ${connectTimeoutMs} its owner gives`, async () => {
      connectorOptions.length = 0;
      const client = createUdsClient(fixedSocket('/nonexistent/momonga-connect-bound.sock'), { connectTimeoutMs });
      await expect(client.request({ method: 'GET', path: '/', signal: new AbortController().signal })).rejects.toThrow();
      await client.destroy();
      expect(connectorOptions).toEqual([{ socketPath: '/nonexistent/momonga-connect-bound.sock', timeout: connectTimeoutMs }]);
    });
  }
});
