import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { OutboundConnectionError } from '@momonga/foundation';
import type { NetworkConfig, OutboundNetwork } from '@momonga/foundation';
import { McpRemotePolicyError, createGuardedFetch, isTransientRemoteFailure } from '@momonga/mcp';
import type { HostResolver } from '@momonga/mcp';
import { onCleanup } from './mcp-harness.ts';
import { makeRemoteConnection, startHttpFixture } from './remote-harness.ts';

const TEST_TIMEOUT_MS = 30_000;
const PASSWORD = 'proxy-password-secret';

type FakeProxy = { port: number; received: () => string; connections: () => number };

const startTcpProxy = async (onRequest: (socket: net.Socket) => void): Promise<FakeProxy> => {
  let text = '';
  let count = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    count += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1');
      if (text.includes('\r\n\r\n')) onRequest(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onCleanup(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port, received: () => text, connections: () => count };
};

const silentProxy = (): Promise<FakeProxy> => startTcpProxy(() => undefined);

const replyingProxy = (reply: string): Promise<FakeProxy> =>
  startTcpProxy((socket) => {
    if (socket.writable) socket.end(reply);
  });

const startForwardingProxy = async (upstreamPort: number): Promise<{ port: number; forwarded: () => string[] }> => {
  const forwarded: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((request, response) => {
    const target = new URL(String(request.url));
    forwarded.push(`${request.method} ${target.href}`);
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
  return { port: (server.address() as AddressInfo).port, forwarded: () => forwarded };
};

const viaProxy = (port: number): OutboundNetwork => {
  const config: NetworkConfig = {
    httpProxy: { value: `http://user:${PASSWORD}@127.0.0.1:${port}`, source: 'HTTP_PROXY' },
    httpsProxy: { value: `http://user:${PASSWORD}@127.0.0.1:${port}`, source: 'network.httpsProxy' },
    caFiles: [],
  };
  return { config, trust: { sources: [], failures: [] } };
};

const rejectionOf = (pending: Promise<unknown>): Promise<unknown> =>
  pending.then(
    () => undefined,
    (error: unknown) => error,
  );

const resolverTo = (...addresses: string[]): HostResolver => () => Promise.resolve(addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

const unresolvable: HostResolver = (hostname) => Promise.reject(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));

describe('MCP over HTTP goes through the configured proxy', { timeout: TEST_TIMEOUT_MS }, () => {
  it('runs a user-scope session through the http proxy', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const proxy = await startForwardingProxy(Number(new URL(fixture.url).port));
    const url = `http://mcp.example.test:8080${new URL(fixture.url).pathname}`;
    const { connection } = makeRemoteConnection({ fixture: { url }, scope: 'user', network: viaProxy(proxy.port) });

    expect((await connection.listTools()).length).toBeGreaterThan(0);
    expect(proxy.forwarded()[0]).toBe(`POST ${url}`);
    expect(fixture.records.length).toBeGreaterThan(0);
  });

  it('keeps a loopback user-scope server direct with a proxy configured', async () => {
    const fixture = await startHttpFixture({ era: 'modern' });
    const proxy = await silentProxy();
    const { connection } = makeRemoteConnection({ fixture, scope: 'user', network: viaProxy(proxy.port) });

    expect((await connection.listTools()).length).toBeGreaterThan(0);
    expect(proxy.connections()).toBe(0);
  });

  it('ends a CONNECT the proxy never answers with the MCP connect bound and names the proxy and its source', async () => {
    const proxy = await silentProxy();
    const guarded = createGuardedFetch({ scope: 'user', network: viaProxy(proxy.port), connectTimeoutMs: 500 });
    onCleanup(() => guarded.close());

    const failure = await rejectionOf(guarded.fetch('https://mcp.example.test/mcp', { method: 'POST', body: '{}' }));

    expect(failure).toBeInstanceOf(OutboundConnectionError);
    expect(proxy.received()).toContain('CONNECT mcp.example.test:443');
    expect((failure as OutboundConnectionError).failure).toMatchObject({ kind: 'proxy-unreachable', proxy: `http://127.0.0.1:${proxy.port}`, source: 'network.httpsProxy' });
    expect(isTransientRemoteFailure(failure)).toBe(true);
  });

  it('reports a proxy that asks for credentials by its host and source, without the password, and does not retry it', async () => {
    const proxy = await replyingProxy('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
    const { connection } = makeRemoteConnection({ fixture: { url: 'https://mcp.example.test/mcp' }, scope: 'user', network: viaProxy(proxy.port) });

    const failure = await rejectionOf(connection.listTools());

    expect(failure).toBeInstanceOf(Error);
    const text = `${(failure as Error).message} ${connection.diagnostics().lastError}`;
    expect(text).toContain(`http://127.0.0.1:${proxy.port}`);
    expect(text).toContain('network.httpsProxy');
    expect(text).toContain('407');
    expect(text).not.toContain(PASSWORD);
    expect(isTransientRemoteFailure(failure)).toBe(false);
  });
});

describe('a project-scope server behind a proxy keeps the resolved-address guard', { timeout: TEST_TIMEOUT_MS }, () => {
  const projectConnection = (proxy: FakeProxy, resolver: HostResolver) =>
    makeRemoteConnection({ fixture: { url: 'https://mcp.example.test/mcp' }, scope: 'project', resolver, network: viaProxy(proxy.port) });

  it('refuses a name that resolves here to a non-public address, before the proxy is used', async () => {
    const proxy = await replyingProxy('HTTP/1.1 200 Connection Established\r\n\r\n');
    const { connection } = projectConnection(proxy, resolverTo('10.1.2.3'));

    const failure = await rejectionOf(connection.listTools());

    expect(failure).toBeInstanceOf(McpRemotePolicyError);
    expect(failure).toMatchObject({ violation: 'non_public_resolved_address' });
    expect((failure as Error).message).toContain('non-public address (10.1.2.3)');
    expect((failure as Error).message).toContain('user settings');
    expect(proxy.connections()).toBe(0);
  });

  it('refuses a name that does not resolve here, saying the address could not be verified and that user settings are not subject to the check', async () => {
    const proxy = await replyingProxy('HTTP/1.1 200 Connection Established\r\n\r\n');
    const { connection } = projectConnection(proxy, unresolvable);

    const failure = await rejectionOf(connection.listTools());

    expect(failure).toBeInstanceOf(McpRemotePolicyError);
    expect(failure).toMatchObject({ violation: 'unresolvable_host' });
    expect((failure as Error).message).toContain('could not be verified');
    expect((failure as Error).message).toContain('ENOTFOUND');
    expect((failure as Error).message).toContain('user settings');
    expect(proxy.connections()).toBe(0);
  });

  it('is reported by authState as refused and never opens the circuit', async () => {
    const proxy = await replyingProxy('HTTP/1.1 200 Connection Established\r\n\r\n');
    const { connection } = projectConnection(proxy, unresolvable);

    for (let attempt = 0; attempt < 5; attempt += 1) expect(await rejectionOf(connection.listTools())).toBeInstanceOf(McpRemotePolicyError);
    const probe = await connection.authState(new AbortController().signal);

    expect(probe.state).toBe('refused');
    expect(probe.detail).toContain('could not be verified');
    expect(connection.diagnostics().state).toBe('disconnected');
    expect(proxy.connections()).toBe(0);
  });

  it('uses the proxy once the name has resolved here to public addresses', async () => {
    const proxy = await replyingProxy('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    const { connection } = projectConnection(proxy, resolverTo('93.184.216.34'));

    const failure = await rejectionOf(connection.listTools());

    expect(failure).not.toBeInstanceOf(McpRemotePolicyError);
    expect(proxy.received()).toContain('CONNECT mcp.example.test:443');
  });

  it('a user-scope server goes through the proxy without a local resolution', async () => {
    const proxy = await replyingProxy('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    let resolutions = 0;
    const counting: HostResolver = (hostname) => {
      resolutions += 1;
      return unresolvable(hostname);
    };
    const { connection } = makeRemoteConnection({ fixture: { url: 'https://mcp.example.test/mcp' }, scope: 'user', resolver: counting, network: viaProxy(proxy.port) });

    await rejectionOf(connection.listTools());

    expect(resolutions).toBe(0);
    expect(proxy.received()).toContain('CONNECT mcp.example.test:443');
  });
});

describe('the OAuth requests of an MCP server use the same routes', { timeout: TEST_TIMEOUT_MS }, () => {
  it('sends the authorization discovery of a user-scope server through the proxy', async () => {
    const proxy = await replyingProxy('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    const { connection } = makeRemoteConnection({ fixture: { url: 'https://mcp.example.test/mcp' }, scope: 'user', network: viaProxy(proxy.port) });

    const failure = await rejectionOf(connection.authorize(new AbortController().signal));

    expect(failure).toBeInstanceOf(Error);
    expect(proxy.received()).toContain('CONNECT mcp.example.test:443');
  });
});
