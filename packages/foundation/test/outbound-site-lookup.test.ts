import net from 'node:net';
import type { AddressInfo, LookupFunction } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createOutboundDispatcher, outboundFetch } from '@momonga/foundation';
import type { NetworkConfig, OutboundNetwork } from '@momonga/foundation';

const TEST_TIMEOUT_MS = 30_000;
const CONNECT_BOUND_MS = 500;

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

type FakeProxy = { port: number; received: () => string; connections: () => number };

const startProxy = async (reply: string): Promise<FakeProxy> => {
  let text = '';
  let count = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    count += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1');
      if (text.includes('\r\n\r\n') && socket.writable) socket.end(reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port, received: () => text, connections: () => count };
};

const viaProxy = (port: number): NetworkConfig => ({
  httpProxy: { value: `http://127.0.0.1:${port}`, source: 'HTTP_PROXY' },
  httpsProxy: { value: `http://127.0.0.1:${port}`, source: 'HTTPS_PROXY' },
  caFiles: [],
});

const networkOf = (config: NetworkConfig): OutboundNetwork => ({ config, trust: { sources: [], failures: [] } });

class SiteRefusal extends Error {}

type RecordingLookup = { lookup: LookupFunction; asked: string[] };

const lookupThat = (answer: (hostname: string) => Error | string): RecordingLookup => {
  const asked: string[] = [];
  const lookup = (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void): void => {
    asked.push(hostname);
    const answered = answer(hostname);
    queueMicrotask(() => {
      if (answered instanceof Error) callback(answered);
      else if (options.all === true) callback(null, [{ address: answered, family: 4 }]);
      else callback(null, answered, 4);
    });
  };
  return { lookup: lookup as unknown as LookupFunction, asked };
};

const fetchThrough = (network: OutboundNetwork, lookup: LookupFunction) => {
  const dispatcher = createOutboundDispatcher(network, { connectReplyTimeoutMs: CONNECT_BOUND_MS, lookup });
  closers.push(() => dispatcher.destroy());
  return outboundFetch(dispatcher);
};

const causeOf = async (pending: Promise<unknown>): Promise<unknown> => {
  const error = await pending.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(TypeError);
  return (error as Error).cause;
};

describe("createOutboundDispatcher: the site's own lookup is asked on every route", { timeout: TEST_TIMEOUT_MS }, () => {
  it("returns the refusal of the site's lookup unchanged on the direct route", async () => {
    const refusal = new SiteRefusal('the site refuses this host');
    const { lookup, asked } = lookupThat(() => refusal);

    const cause = await causeOf(fetchThrough(networkOf({ caFiles: [] }), lookup)('http://refused.example.test:8080/'));

    expect(cause).toBe(refusal);
    expect(asked).toEqual(['refused.example.test']);
  });

  it("asks the site's lookup for the destination before the proxy is used, and a refusal never reaches the proxy", async () => {
    const proxy = await startProxy('HTTP/1.1 200 Connection Established\r\n\r\n');
    const refusal = new SiteRefusal('the site refuses this host');
    const { lookup, asked } = lookupThat(() => refusal);

    const cause = await causeOf(fetchThrough(networkOf(viaProxy(proxy.port)), lookup)('https://refused.example.test/'));

    expect(cause).toBe(refusal);
    expect(asked).toEqual(['refused.example.test']);
    expect(proxy.connections()).toBe(0);
  });

  it('refuses a plain http destination that the proxy would forward without a tunnel', async () => {
    const proxy = await startProxy('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
    const refusal = new SiteRefusal('the site refuses this host');
    const { lookup } = lookupThat(() => refusal);

    const cause = await causeOf(fetchThrough(networkOf(viaProxy(proxy.port)), lookup)('http://refused.example.test:8080/'));

    expect(cause).toBe(refusal);
    expect(proxy.connections()).toBe(0);
  });

  it('uses the proxy once the lookup has answered for the destination', async () => {
    const proxy = await startProxy('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
    const { lookup, asked } = lookupThat(() => '93.184.216.34');

    const response = await fetchThrough(networkOf(viaProxy(proxy.port)), lookup)('http://allowed.example.test:8080/path');

    expect(await response.text()).toBe('ok');
    expect(asked).toEqual(['allowed.example.test']);
    expect(proxy.received()).toContain('GET http://allowed.example.test:8080/path');
  });

  it('asks again for every request through the proxy, so a name that stops verifying is refused on its next request', async () => {
    const proxy = await startProxy('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
    const refusal = new SiteRefusal('the site refuses this host now');
    let verified = true;
    const { lookup } = lookupThat(() => (verified ? '93.184.216.34' : refusal));
    const fetch = fetchThrough(networkOf(viaProxy(proxy.port)), lookup);

    expect(await (await fetch('http://moving.example.test:8080/')).text()).toBe('ok');
    verified = false;

    expect(await causeOf(fetch('http://moving.example.test:8080/'))).toBe(refusal);
    expect(proxy.connections()).toBe(1);
  });
});
