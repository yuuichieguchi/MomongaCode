import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExportResult } from '@opentelemetry/core';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { createOtlpTraceExporter } from '@momonga/observability';
import { findOutboundError } from '@momonga/foundation';
import type { NetworkConfig, OutboundNetwork, TrustReport } from '@momonga/foundation';
import { waitFor } from '@momonga/testkit';

const EXPORT_TIMEOUT_MS = 300;
const TEST_TIMEOUT_MS = 30_000;
const COLLECTOR_HOST = 'collector.example.test';
const CA_FILE = '/nonexistent/corporate-ca.pem';
const NO_TRUST_FAILURES: TrustReport = { sources: [], failures: [] };

type Listener = { port: number; connections: () => number; open: () => number };

const closers: Array<() => Promise<void>> = [];
const uncaught: unknown[] = [];
const onUncaught = (error: unknown): void => void uncaught.push(error);

afterEach(async () => {
  process.off('uncaughtException', onUncaught);
  await Promise.all(closers.splice(0).map((close) => close()));
});

const listen = async (onSocket: (socket: net.Socket) => void): Promise<Listener> => {
  const sockets = new Set<net.Socket>();
  let count = 0;
  const server = net.createServer((socket) => {
    count += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    onSocket(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port, connections: () => count, open: () => sockets.size };
};

const silentTls = (): Promise<Listener> => listen((socket) => socket.resume());

const tunnelTo = (port: number): Promise<Listener> =>
  listen((socket) => {
    socket.once('data', () => {
      const upstream = net.connect(port, '127.0.0.1');
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  });

const networkOf = (config: Partial<NetworkConfig>, trust: TrustReport = NO_TRUST_FAILURES): OutboundNetwork => ({ config: { caFiles: [], ...config }, trust });

const exportOnce = async (endpoint: string, network: OutboundNetwork): Promise<ExportResult> => {
  const exporter = createOtlpTraceExporter({ endpoint }, { network, timeoutMs: EXPORT_TIMEOUT_MS });
  const result = await new Promise<ExportResult>((resolve) => exporter.export([], resolve));
  await exporter.shutdown();
  return result;
};

describe('the OTLP exporter refuses what the outbound plan refuses, before any connection', { timeout: TEST_TIMEOUT_MS }, () => {
  it('fails an https export while a configured CA file is not loaded, naming the file and its source, and connects nowhere', async () => {
    const proxy = await listen((socket) => socket.resume());
    const network = networkOf(
      { httpsProxy: { value: `http://127.0.0.1:${proxy.port}`, source: 'HTTPS_PROXY' }, caFiles: [{ value: CA_FILE, source: 'network.extraCaFiles' }] },
      { sources: [], failures: [{ file: CA_FILE, source: 'network.extraCaFiles', reason: 'the file could not be read (ENOENT)' }] },
    );

    const result = await exportOnce(`https://${COLLECTOR_HOST}:4318`, network);

    expect(result.code).toBe(1);
    const labelled = findOutboundError(result.error);
    expect(labelled?.failure).toMatchObject({ kind: 'ca-file', file: CA_FILE, source: 'network.extraCaFiles' });
    expect(labelled?.message).toContain(CA_FILE);
    expect(proxy.connections()).toBe(0);
  });

  it('fails an export whose selected proxy has an unsupported scheme, naming its source, and connects nowhere', async () => {
    const proxy = await listen((socket) => socket.resume());
    const network = networkOf({ httpsProxy: { value: `socks5://127.0.0.1:${proxy.port}`, source: 'HTTPS_PROXY' } });

    const result = await exportOnce(`https://${COLLECTOR_HOST}:4318`, network);

    expect(result.code).toBe(1);
    const labelled = findOutboundError(result.error);
    expect(labelled?.failure).toMatchObject({ kind: 'proxy-unsupported', source: 'HTTPS_PROXY' });
    expect(labelled?.message).toContain('only http and https proxies are supported');
    expect(proxy.connections()).toBe(0);
  });
});

describe('the export timeout bounds an origin TLS handshake that never completes', { timeout: TEST_TIMEOUT_MS }, () => {
  it('direct: ends the export as origin-connection, closes the socket and raises no uncaught error', async () => {
    process.on('uncaughtException', onUncaught);
    const collector = await silentTls();

    const result = await exportOnce(`https://localhost:${collector.port}`, networkOf({}));

    expect(result.code).toBe(1);
    expect(findOutboundError(result.error)?.failure.kind).toBe('origin-connection');
    expect(collector.connections()).toBeGreaterThan(0);
    await waitFor(() => collector.open() === 0, { description: 'the exporter closes its socket to the silent collector' });
    expect(uncaught).toEqual([]);
  });

  it('through the tunnel: ends the export as origin-connection, closes every socket and raises no uncaught error', async () => {
    process.on('uncaughtException', onUncaught);
    const collector = await silentTls();
    const proxy = await tunnelTo(collector.port);

    const result = await exportOnce(`https://${COLLECTOR_HOST}:4318`, networkOf({ httpsProxy: { value: `http://127.0.0.1:${proxy.port}`, source: 'HTTPS_PROXY' } }));

    expect(result.code).toBe(1);
    expect(findOutboundError(result.error)?.failure.kind).toBe('origin-connection');
    expect(collector.connections()).toBeGreaterThan(0);
    await waitFor(() => collector.open() === 0 && proxy.open() === 0, { description: 'the exporter closes the tunnel and the collector socket' });
    expect(uncaught).toEqual([]);
  });
});

describe('the pinned https-proxy-agent reads its connect options synchronously', () => {
  it('reads connectOpts before connect returns, which the per-connection CONNECT signal relies on', async () => {
    const proxy = await listen((socket) => socket.resume());
    const agent = new HttpsProxyAgent(`http://127.0.0.1:${proxy.port}`);
    const options = agent.connectOpts;
    let reads = 0;
    Object.defineProperty(agent, 'connectOpts', {
      configurable: true,
      get: () => {
        reads += 1;
        return options;
      },
    });
    const req = http.request({ host: '127.0.0.1', port: proxy.port, agent: false });
    req.on('error', () => undefined);

    const connecting = agent.connect(req, { host: COLLECTOR_HOST, port: 4318, secureEndpoint: false });
    const readsBeforeFirstAwait = reads;

    req.destroy();
    agent.destroy();
    closers.push(async () => {
      await connecting.then(
        (socket) => void socket.destroy(),
        () => undefined,
      );
    });
    expect(readsBeforeFirstAwait).toBeGreaterThan(0);
  });
});
