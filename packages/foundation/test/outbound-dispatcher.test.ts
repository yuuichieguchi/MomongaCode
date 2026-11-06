import net from 'node:net';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'undici';
import { OutboundConnectionError, createOutboundDispatcher, outboundFetch } from '@momonga/foundation';
import type { NetworkConfig, OutboundNetwork, TrustReport } from '@momonga/foundation';

const NO_TRUST_FAILURES: TrustReport = { sources: [], failures: [] };
const REMOTE_HTTPS = 'https://model.example.test/v1/chat/completions';
const REMOTE_HTTP = 'http://lan-model.example.test:1234/v1/models';
const PASSWORD = 'proxy-password-secret';
const TEST_TIMEOUT_MS = 30_000;

type FakeProxy = { port: number; received: () => string; connections: () => number };

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const startFakeProxy = async (onData: (socket: net.Socket, text: string) => void): Promise<FakeProxy> => {
  let text = '';
  let count = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    count += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1');
      onData(socket, text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port, received: () => text, connections: () => count };
};

const silentProxy = (): Promise<FakeProxy> => startFakeProxy(() => undefined);

const replyingProxy = (reply: string): Promise<FakeProxy> =>
  startFakeProxy((socket, text) => {
    if (text.includes('\r\n\r\n') && socket.writable) socket.end(reply);
  });

const closedPort = async (): Promise<number> => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

const startOrigin = async (): Promise<{ url: string; hits: () => number }> => {
  let hits = 0;
  const server = http.createServer((_request, response) => {
    hits += 1;
    response.end('from origin');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hello`, hits: () => hits };
};

const viaProxy = (port: number, source: 'HTTPS_PROXY' | 'network.httpsProxy' = 'HTTPS_PROXY'): NetworkConfig => ({
  httpProxy: { value: `http://user:${PASSWORD}@127.0.0.1:${port}`, source: 'HTTP_PROXY' },
  httpsProxy: { value: `http://user:${PASSWORD}@127.0.0.1:${port}`, source },
  caFiles: [],
});

const networkOf = (config: NetworkConfig, trust: TrustReport = NO_TRUST_FAILURES): OutboundNetwork => ({ config, trust });

const failureOf = async (pending: Promise<unknown>): Promise<OutboundConnectionError> => {
  const error = await pending.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OutboundConnectionError);
  return error as OutboundConnectionError;
};

const dispatcherFor = (network: OutboundNetwork, connectReplyTimeoutMs: number) => {
  const dispatcher = createOutboundDispatcher(network, { connectReplyTimeoutMs });
  closers.push(() => dispatcher.destroy());
  return dispatcher;
};

describe('createOutboundDispatcher: the CONNECT wait is bounded by the operation', { timeout: TEST_TIMEOUT_MS }, () => {
  it('ends a CONNECT that the proxy never answers with the operation bound and names the proxy hop and its source', async () => {
    const proxy = await silentProxy();
    const dispatcher = dispatcherFor(networkOf(viaProxy(proxy.port)), 500);

    const error = await failureOf(request(REMOTE_HTTPS, { dispatcher, method: 'POST', body: '{}' }));

    expect(proxy.received()).toContain('CONNECT model.example.test:443');
    expect(error.hop).toBe('proxy');
    expect(error.failure).toMatchObject({ kind: 'proxy-unreachable', proxy: `http://127.0.0.1:${proxy.port}`, source: 'HTTPS_PROXY' });
    expect(error.message).toContain(`http://127.0.0.1:${proxy.port}`);
    expect(error.message).toContain('HTTPS_PROXY');
    expect(error.message).not.toContain(PASSWORD);
  });

  it.for([-1, 1.5, Number.NaN])('refuses to build with %s as the CONNECT bound', (bound) => {
    expect(() => createOutboundDispatcher(networkOf({ caFiles: [] }), { connectReplyTimeoutMs: bound })).toThrow(/bound/);
  });
});

describe('createOutboundDispatcher: proxy failures name the hop and never fall back to direct', { timeout: TEST_TIMEOUT_MS }, () => {
  it('names a refused proxy connection as the proxy hop', async () => {
    const port = await closedPort();
    const dispatcher = dispatcherFor(networkOf(viaProxy(port, 'network.httpsProxy')), 5_000);

    const error = await failureOf(request(REMOTE_HTTPS, { dispatcher }));

    expect(error.hop).toBe('proxy');
    expect(error.failure).toMatchObject({ kind: 'proxy-unreachable', source: 'network.httpsProxy', proxy: `http://127.0.0.1:${port}` });
  });

  it('names a 407 reply and says where the credentials go', async () => {
    const proxy = await replyingProxy('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
    const dispatcher = dispatcherFor(networkOf(viaProxy(proxy.port)), 5_000);

    const error = await failureOf(request(REMOTE_HTTPS, { dispatcher }));

    expect(error.failure).toMatchObject({ kind: 'proxy-auth', source: 'HTTPS_PROXY' });
    expect(error.message).toContain('the proxy requires credentials; put them in the proxy URL');
    expect(error.message).not.toContain(PASSWORD);
    expect(proxy.received().toLowerCase()).toContain('proxy-authorization: basic');
  });

  it('names another non-200 CONNECT reply with its status', async () => {
    const proxy = await replyingProxy('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    const dispatcher = dispatcherFor(networkOf(viaProxy(proxy.port)), 5_000);

    const error = await failureOf(request(REMOTE_HTTPS, { dispatcher }));

    expect(error.failure).toMatchObject({ kind: 'proxy-refused', status: 403, source: 'HTTPS_PROXY' });
  });

  it('reports an unsupported proxy scheme with its source', async () => {
    const config: NetworkConfig = { httpsProxy: { value: 'socks5://127.0.0.1:1080', source: 'ALL_PROXY' }, caFiles: [] };
    const dispatcher = dispatcherFor(networkOf(config), 5_000);

    const error = await failureOf(request(REMOTE_HTTPS, { dispatcher }));

    expect(error.hop).toBe('proxy');
    expect(error.failure).toMatchObject({ kind: 'proxy-unsupported', source: 'ALL_PROXY' });
    expect(error.message).toContain('only http and https proxies are supported');
  });
});

describe('createOutboundDispatcher: routes', { timeout: TEST_TIMEOUT_MS }, () => {
  it('sends a loopback destination direct even with a proxy configured', async () => {
    const proxy = await silentProxy();
    const origin = await startOrigin();
    const dispatcher = dispatcherFor(networkOf(viaProxy(proxy.port)), 5_000);

    const response = await request(origin.url, { dispatcher });

    expect(await response.body.text()).toBe('from origin');
    expect(proxy.connections()).toBe(0);
  });

  it('forwards a plain http destination through the http proxy with its credentials', async () => {
    const proxy = await replyingProxy('HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nvia proxy');
    const dispatcher = dispatcherFor(networkOf(viaProxy(proxy.port)), 5_000);

    const response = await request(REMOTE_HTTP, { dispatcher });

    expect(await response.body.text()).toBe('via proxy');
    expect(proxy.received()).toContain(`GET ${REMOTE_HTTP} HTTP/1.1`);
    expect(proxy.received().toLowerCase()).toContain('proxy-authorization: basic');
  });

  it('gives a fetch that uses the same routes', async () => {
    const proxy = await silentProxy();
    const origin = await startOrigin();
    const dispatcher = dispatcherFor(networkOf(viaProxy(proxy.port)), 5_000);

    const response = await outboundFetch(dispatcher)(origin.url);

    expect(await response.text()).toBe('from origin');
    expect(origin.hits()).toBe(1);
    expect(proxy.connections()).toBe(0);
  });
});

describe('createOutboundDispatcher: a CA file that could not be loaded', { timeout: TEST_TIMEOUT_MS }, () => {
  const trust: TrustReport = { sources: [], failures: [{ file: '/etc/corp/missing-ca.pem', source: 'network.extraCaFiles', reason: 'the file could not be read (ENOENT)' }] };

  it('fails an https request to a remote origin naming the file and its source', async () => {
    const dispatcher = dispatcherFor(networkOf({ caFiles: [] }, trust), 5_000);

    const error = await failureOf(request(REMOTE_HTTPS, { dispatcher }));

    expect(error.failure).toMatchObject({ kind: 'ca-file', file: '/etc/corp/missing-ca.pem', source: 'network.extraCaFiles' });
    expect(error.message).toContain('/etc/corp/missing-ca.pem');
    expect(error.message).toContain('network.extraCaFiles');
  });

  it('keeps plain http and loopback destinations working', async () => {
    const origin = await startOrigin();
    const dispatcher = dispatcherFor(networkOf({ caFiles: [] }, trust), 5_000);

    const response = await request(origin.url, { dispatcher });

    expect(await response.body.text()).toBe('from origin');
  });
});
