import http from 'node:http';
import net from 'node:net';
import type { AddressInfo, LookupFunction } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OutboundConnectionError,
  createOutboundDispatcher,
  findOutboundError,
  isAcceptableAddress,
  isLoopbackAddress,
  openOutboundTunnel,
  outboundFetch,
  transportUrlProblem,
} from '@momonga/foundation';
import { isLoopbackHost } from '../src/loopback.ts';
import type { NetworkConfig, OutboundNetwork } from '@momonga/foundation';

const TEST_TIMEOUT_MS = 30_000;
const CONNECT_BOUND_MS = 500;
const PUBLIC_ADDRESS = '203.0.113.9';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const networkOf = (config: NetworkConfig): OutboundNetwork => ({ config, trust: { sources: [], failures: [] } });

const NO_PROXY_CONFIG: NetworkConfig = { caFiles: [] };

type RecordingLookup = { lookup: LookupFunction; asked: string[] };

const lookupAnswering = (address: string): RecordingLookup => {
  const asked: string[] = [];
  const lookup = (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void): void => {
    asked.push(hostname);
    queueMicrotask(() => {
      if (options.all === true) callback(null, [{ address, family: 4 }]);
      else callback(null, address, 4);
    });
  };
  return { lookup: lookup as unknown as LookupFunction, asked };
};

type Origin = { port: number; requests: () => number };

const startOrigin = async (): Promise<Origin> => {
  let count = 0;
  const server = http.createServer((_request, response) => {
    count += 1;
    response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port, requests: () => count };
};

type Listener = { port: number; connections: () => number };

const startListener = async (): Promise<Listener> => {
  let count = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    count += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port, connections: () => count };
};

const fetchThrough = (config: NetworkConfig, lookup: LookupFunction) => {
  const dispatcher = createOutboundDispatcher(networkOf(config), { connectReplyTimeoutMs: CONNECT_BOUND_MS, lookup });
  closers.push(() => dispatcher.destroy());
  return outboundFetch(dispatcher);
};

const failureOf = async (pending: Promise<unknown>): Promise<OutboundConnectionError | undefined> =>
  findOutboundError(
    await pending.then(
      () => undefined,
      (caught: unknown) => caught,
    ),
  );

describe('the loopback exemption is decided by the address connected to', () => {
  it('reads the embedded IPv4 forms before it decides loopback', () => {
    for (const address of ['::ffff:127.0.0.1', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::']) {
      expect(isLoopbackAddress(address)).toBe(true);
      expect(isAcceptableAddress(address, { loopback: true })).toBe(true);
      expect(isAcceptableAddress(address, { loopback: false })).toBe(false);
    }
  });

  it('exempts no name by its text, and still admits a name that claims loopback for http until the connection settles it', () => {
    expect(isLoopbackHost('x.localhost')).toBe(false);
    expect(isLoopbackHost('localhost')).toBe(false);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(transportUrlProblem('http://localhost:11434')).toBeUndefined();
    expect(transportUrlProblem('http://x.localhost:11434')).toBeUndefined();
    expect(transportUrlProblem('http://example.test')).toBe('cleartext');
  });
});

describe('createOutboundDispatcher: a name that claims loopback connects only to a loopback address', { timeout: TEST_TIMEOUT_MS }, () => {
  it('refuses with a typed error when the lookup answers a public address, and no request leaves', async () => {
    const proxy = await startListener();
    const { lookup, asked } = lookupAnswering(PUBLIC_ADDRESS);
    const config: NetworkConfig = { httpProxy: { value: `http://127.0.0.1:${proxy.port}`, source: 'HTTP_PROXY' }, caFiles: [] };

    const failure = await failureOf(fetchThrough(config, lookup)('http://x.localhost:8080/'));

    expect(failure?.failure).toEqual({ kind: 'not-loopback', host: 'x.localhost', address: PUBLIC_ADDRESS });
    expect(asked).toEqual(['x.localhost']);
    expect(proxy.connections()).toBe(0);
  });

  it('connects directly, never through the proxy, when the lookup answers a loopback address', async () => {
    const origin = await startOrigin();
    const proxy = await startListener();
    const { lookup, asked } = lookupAnswering('127.0.0.1');
    const config: NetworkConfig = { httpProxy: { value: `http://127.0.0.1:${proxy.port}`, source: 'HTTP_PROXY' }, caFiles: [] };

    const response = await fetchThrough(config, lookup)(`http://x.localhost:${origin.port}/`);

    expect(await response.text()).toBe('ok');
    expect(asked).toEqual(['x.localhost']);
    expect(origin.requests()).toBe(1);
    expect(proxy.connections()).toBe(0);
  });

  it('connects to a literal loopback address without a lookup', async () => {
    const origin = await startOrigin();
    const { lookup, asked } = lookupAnswering(PUBLIC_ADDRESS);

    const response = await fetchThrough(NO_PROXY_CONFIG, lookup)(`http://127.0.0.1:${origin.port}/`);

    expect(await response.text()).toBe('ok');
    expect(asked).toEqual([]);
  });

  it('refuses a tunnel for a name that claims loopback to a public address', async () => {
    const failure = await failureOf(openOutboundTunnel(networkOf(NO_PROXY_CONFIG), { host: 'x.localhost', address: PUBLIC_ADDRESS, port: 443 }, { connectReplyTimeoutMs: CONNECT_BOUND_MS }));

    expect(failure?.failure).toEqual({ kind: 'not-loopback', host: 'x.localhost', address: PUBLIC_ADDRESS });
  });
});
