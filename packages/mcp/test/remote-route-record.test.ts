import http from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { UNCONFIGURED_NETWORK, createFakeClock } from '@momonga/testkit';
import type { NetworkConfig, OutboundNetwork } from '@momonga/foundation';
import { createManagedConnection } from '@momonga/mcp';
import { BASE_ENV, makeDir, onCleanup } from './mcp-harness.ts';
import { makeRemoteConnection, startHttpFixture } from './remote-harness.ts';

const TEST_TIMEOUT_MS = 30_000;
const PASSWORD = 'proxy-password-secret';

const startForwardingProxy = async (upstreamPort: number): Promise<number> => {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((request, response) => {
    const target = new URL(String(request.url));
    const upstream = http.request(
      { host: '127.0.0.1', port: upstreamPort, method: request.method, path: `${target.pathname}${target.search}`, headers: { ...request.headers, host: `127.0.0.1:${upstreamPort}` } },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on('error', () => response.destroy());
    request.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onCleanup(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
};

const networkOf = (proxyPort: number, noProxy?: string): OutboundNetwork => {
  const config: NetworkConfig = {
    httpProxy: { value: `http://user:${PASSWORD}@127.0.0.1:${proxyPort}`, source: 'HTTP_PROXY' },
    ...(noProxy === undefined ? {} : { noProxy: { value: noProxy, source: 'NO_PROXY' as const } }),
    caFiles: [],
  };
  return { config, trust: { sources: [], failures: [] } };
};

describe('the route an MCP connection took is on its connection record', { timeout: TEST_TIMEOUT_MS }, () => {
  it('records proxy and the proxy host without credentials', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const proxyPort = await startForwardingProxy(Number(new URL(fixture.url).port));
    const url = `http://mcp.example.test:8080${new URL(fixture.url).pathname}`;
    const { connection } = makeRemoteConnection({ fixture: { url }, scope: 'user', network: networkOf(proxyPort) });

    expect(connection.diagnostics().route).toBeUndefined();
    await connection.listTools();

    const record = connection.diagnostics();
    expect(record.route).toBe('proxy');
    expect(record.proxyHost).toBe(`127.0.0.1:${proxyPort}`);
    expect(JSON.stringify(record)).not.toContain(PASSWORD);
  });

  it('records direct for a loopback server with a proxy configured', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture, scope: 'user', network: networkOf(9) });

    await connection.listTools();

    const record = connection.diagnostics();
    expect(record.route).toBe('direct');
    expect('proxyHost' in record).toBe(false);
  });

  it('records direct with no proxy configured', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const { connection } = makeRemoteConnection({ fixture, scope: 'user', network: UNCONFIGURED_NETWORK });

    await connection.listTools();

    expect(connection.diagnostics().route).toBe('direct');
  });

  it('records bypass for a server that noProxy names, also when the connect fails', async () => {
    const { connection } = makeRemoteConnection({
      fixture: { url: 'http://mcp.example.test:8080/mcp' },
      scope: 'project',
      network: networkOf(9, 'mcp.example.test'),
      resolver: () => Promise.resolve([{ address: '10.0.0.1', family: 4 }]),
    });

    await expect(connection.listTools()).rejects.toThrow();

    const record = connection.diagnostics();
    expect(record.route).toBe('bypass');
    expect('proxyHost' in record).toBe(false);
  });

  it('records no route for a stdio server', () => {
    const connection = createManagedConnection({
      name: 'local',
      config: { command: process.execPath, args: ['-e', ''] },
      scope: 'user',
      projectDir: makeDir(),
      baseEnv: BASE_ENV,
      clock: createFakeClock(1_000_000),
    });
    onCleanup(() => connection.close());

    expect('route' in connection.diagnostics()).toBe(false);
  });
});
