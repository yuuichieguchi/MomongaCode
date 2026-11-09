import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { OutboundNetwork } from '@momonga/foundation';
import { createProbeClient } from '../src/probe/client.ts';
import { createEndpointPool } from '../src/adapters/shared/http-client.ts';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const silentProxy = async (): Promise<{ port: number; received: () => string }> => {
  let text = '';
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port, received: () => text };
};

const throughProxy = (port: number): OutboundNetwork => ({
  config: { httpsProxy: { value: `http://127.0.0.1:${port}`, source: 'HTTPS_PROXY' }, caFiles: [] },
  trust: { sources: [], failures: [] },
});

describe('a probe of a TCP endpoint behind a proxy that never answers CONNECT', { timeout: 30_000 }, () => {
  it('ends at the probe step bound', async () => {
    const proxy = await silentProxy();
    const client = createProbeClient({ kind: 'tcp', baseUrl: 'https://model.example.test/v1', network: throughProxy(proxy.port) }, undefined, 300);
    closers.push(() => client.close());

    await expect(client.get('models')).rejects.toThrow(/300 ms/);
    expect(proxy.received()).toContain('CONNECT model.example.test:443');
  });
});

describe('a model call to a TCP endpoint behind a proxy that never answers CONNECT', { timeout: 30_000 }, () => {
  it('ends at the model headers bound and names the proxy hop', async () => {
    const proxy = await silentProxy();
    const pool = createEndpointPool({ label: 'chat-completions', unixPath: '/v1/chat/completions', urlSuffix: '/chat/completions' }, { headersTimeoutMs: 300, idleTimeoutMs: 300 });
    closers.push(() => pool.close());

    const pending = pool.clientFor({ kind: 'tcp', baseUrl: 'https://model.example.test/v1', network: throughProxy(proxy.port) }).post({ headers: {}, body: '{}', signal: new AbortController().signal });

    await expect(pending).rejects.toMatchObject({ hop: 'proxy', failure: { kind: 'proxy-unreachable', source: 'HTTPS_PROXY' } });
    expect(proxy.received()).toContain('CONNECT model.example.test:443');
  });
});
