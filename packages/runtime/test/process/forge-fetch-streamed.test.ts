import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { TrustReport } from '@momonga/foundation';
import * as runtime from '@momonga/runtime';
import { MAX_FORGE_RESPONSE_BYTES } from '@momonga/tools';
import { onCleanup, signalNever } from './helpers.ts';

const NO_TRUST: TrustReport = { sources: [], failures: [] };

const SENT_BEFORE_HOLDING_BYTES = MAX_FORGE_RESPONSE_BYTES + 1024 * 1024;

const proxyThatNeverEnds = async (): Promise<string> => {
  const sockets = new Set<Socket>();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(Buffer.alloc(SENT_BEFORE_HOLDING_BYTES, 0x20));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onCleanup(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

describe('a forge answer reaches the reader as a stream', () => {
  it('answers before the body ends, so the reader stops at the size bound and nothing past it is held', async () => {
    const proxy = await proxyThatNeverEnds();
    const fetch = runtime.outboundForgeFetch(async () => ({
      outbound: { config: { httpProxy: { value: proxy, source: 'network.httpProxy' }, httpsProxy: { value: proxy, source: 'network.httpProxy' }, caFiles: [] }, trust: NO_TRUST },
      identity: proxy,
    }));

    const response = await fetch(new URL('http://forge.invalid/big'), { boundMs: 10_000, method: 'GET', redirect: 'error', signal: signalNever(), headers: {} });
    const reader = response.body!.getReader();
    let received = 0;
    while (received <= MAX_FORGE_RESPONSE_BYTES) {
      const step = await reader.read();
      if (step.done) break;
      received += step.value.byteLength;
    }
    await reader.cancel();

    expect(received).toBeGreaterThan(MAX_FORGE_RESPONSE_BYTES);
    expect(received).toBeLessThan(SENT_BEFORE_HOLDING_BYTES + 1);
  });
});
