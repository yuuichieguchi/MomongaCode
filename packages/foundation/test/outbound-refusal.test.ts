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

describe('C15: a refusal is delivered to the request it refuses, with its own error', { timeout: TEST_TIMEOUT_MS }, () => {
  it('gives each of two refusals with the same text its own error and cause', async () => {
    const proxy = await startProxy('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
    const refusals: SiteRefusal[] = [];
    const { lookup } = lookupThat(() => {
      const refusal = new SiteRefusal('the site refuses this host', { cause: { attempt: refusals.length } });
      refusals.push(refusal);
      return refusal;
    });
    const fetch = fetchThrough(networkOf(viaProxy(proxy.port)), lookup);

    const first = await causeOf(fetch('http://refused.example.test:8080/'));
    const second = await causeOf(fetch('http://refused.example.test:8080/'));

    expect(first).toBe(refusals[0]);
    expect(second).toBe(refusals[1]);
    expect((second as Error).cause).toEqual({ attempt: 1 });
  });

  it('still delivers its own error after a thousand refusals with distinct texts', async () => {
    const proxy = await startProxy('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
    let count = 0;
    let last: SiteRefusal | undefined;
    const { lookup } = lookupThat(() => {
      count += 1;
      last = new SiteRefusal(`the site refuses host number ${count}`);
      return last;
    });
    const fetch = fetchThrough(networkOf(viaProxy(proxy.port)), lookup);
    for (let index = 0; index < 1000; index += 1) await causeOf(fetch(`http://refused-${index}.example.test:8080/`));
    const again = new SiteRefusal('the site refuses host number 1');
    const { lookup: repeating } = lookupThat(() => again);
    const fetchAgain = fetchThrough(networkOf(viaProxy(proxy.port)), repeating);
    expect(await causeOf(fetchAgain('http://refused-0.example.test:8080/'))).toBe(again);
    expect(await causeOf(fetch('http://refused-0.example.test:8080/'))).toBe(last);
  });
});
