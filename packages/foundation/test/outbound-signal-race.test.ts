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

type HeldLookup = { lookup: LookupFunction; answer(address: string): void; asked: Promise<void> };

const heldLookup = (): HeldLookup => {
  const waiting: Array<(...args: unknown[]) => void> = [];
  let held = false;
  let markAsked: () => void = () => undefined;
  const asked = new Promise<void>((resolve) => {
    markAsked = resolve;
  });
  const lookup = (_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void): void => {
    if (!held && options.all === true) {
      held = true;
      waiting.push(callback);
      markAsked();
      return;
    }
    queueMicrotask(() => callback(null, [{ address: '93.184.216.34', family: 4 }]));
  };
  return {
    lookup: lookup as unknown as LookupFunction,
    answer: (address) => {
      for (const callback of waiting.splice(0)) callback(null, [{ address, family: 4 }]);
    },
    asked,
  };
};

describe('C14: the site lookup of a request is raced against the signal of its asker', { timeout: TEST_TIMEOUT_MS }, () => {
  it('rejects with the reason of the signal while the lookup has not answered, and never dispatches once it answers', async () => {
    const proxy = await startProxy('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
    const held = heldLookup();
    const dispatcher = createOutboundDispatcher(networkOf(viaProxy(proxy.port)), { connectReplyTimeoutMs: CONNECT_BOUND_MS, lookup: held.lookup });
    closers.push(() => dispatcher.destroy());
    const asker = new AbortController();
    const reason = new Error('the asker left');
    const pending = dispatcher.request({ origin: 'http://slow.example.test:8080', path: '/', method: 'GET', signal: asker.signal });
    const outcome = pending.then(
      () => 'answered',
      (error: unknown) => error,
    );
    await held.asked;
    asker.abort(reason);
    expect(await outcome).toBe(reason);
    held.answer('93.184.216.34');
    const later = await dispatcher.request({ origin: 'http://later.example.test:8080', path: '/', method: 'GET' });
    expect(await later.body.text()).toBe('ok');
    expect(proxy.connections()).toBe(1);
  });
});
