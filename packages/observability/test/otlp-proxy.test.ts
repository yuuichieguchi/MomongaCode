import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { createOtlpTraceExporter, exportersFor, installOtelErrorHandler, startAgentSpan, startToolSpan } from '@momonga/observability';
import { findOutboundError, installTrust } from '@momonga/foundation';
import type { NetworkConfig, OutboundNetwork, TrustReport } from '@momonga/foundation';
import { decodeOtlpSpans, startOtlpCollector, waitFor } from '@momonga/testkit';
import type { OtlpCollector } from '@momonga/testkit';
import { RUN_ID, harness, registerCleanup } from './helpers.ts';

const COLLECTOR_HOST = 'collector.example.test';
const PASSWORD = 'proxy-password-secret';
const PROXY_USER = 'user';
const BASIC_CREDENTIALS = Buffer.from(`${PROXY_USER}:${PASSWORD}`).toString('base64');
const COLLECTOR_AUTH = 'collector-auth-value';
const EXPORT_TIMEOUT_MS = 300;
const TEST_TIMEOUT_MS = 30_000;
const NO_TRUST_FAILURES: TrustReport = { sources: [], failures: [] };
const SPAN_NAMES = ['execute_tool Read', 'invoke_agent momonga'];

type Pki = { caFile: string; key: string; cert: string };

type ProxyMode = { kind: 'tunnel'; targets: Map<string, number> } | { kind: 'silent' } | { kind: 'reply'; text: string };

type FakeProxy = { port: number; received: () => string; connections: () => number; open: () => number };

const originalCertificates = tls.getCACertificates('default');
const closers: Array<() => Promise<void>> = [];
const reported: Error[] = [];
let pki: Pki;

const openssl = (args: string[], cwd: string): void => {
  execFileSync('openssl', args, { cwd, stdio: 'ignore' });
};

const makePki = (): Pki => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-otlp-pki-'));
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=momonga-test-ca', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], dir);
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', `/CN=${COLLECTOR_HOST}`], dir);
  fs.writeFileSync(path.join(dir, 'leaf.ext'), `subjectAltName=DNS:${COLLECTOR_HOST}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
  openssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'leaf.ext'], dir);
  closers.push(async () => undefined);
  return { caFile: path.join(dir, 'ca.pem'), key: fs.readFileSync(path.join(dir, 'leaf.key'), 'utf8'), cert: fs.readFileSync(path.join(dir, 'leaf.pem'), 'utf8') };
};

const listen = async (server: net.Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

const track = (server: net.Server, sockets: Set<net.Socket>): void => {
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
};

const startFakeProxy = async (mode: ProxyMode): Promise<FakeProxy> => {
  let text = '';
  let count = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    count += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let head = Buffer.alloc(0);
    let handled = false;
    const onData = (chunk: Buffer): void => {
      text += chunk.toString('latin1');
      if (handled) return;
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      handled = true;
      if (mode.kind === 'silent') return;
      if (mode.kind === 'reply') {
        socket.end(mode.text);
        return;
      }
      const requestLine = head.subarray(0, head.indexOf('\r\n')).toString('latin1');
      const [method, target] = requestLine.split(' ');
      const authority = method === 'CONNECT' ? (target ?? '') : new URL(target ?? '').host;
      const port = mode.targets.get(authority);
      if (port === undefined) {
        socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      socket.off('data', onData);
      socket.on('data', (more: Buffer) => {
        text += more.toString('latin1');
      });
      const upstream = net.connect(port, '127.0.0.1');
      sockets.add(upstream);
      upstream.on('error', () => socket.destroy());
      upstream.on('close', () => socket.destroy());
      if (method === 'CONNECT') {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const rest = head.subarray(end + 4);
        if (rest.length > 0) upstream.write(rest);
      } else {
        upstream.write(head);
      }
      socket.pipe(upstream);
      upstream.pipe(socket);
    };
    socket.on('data', onData);
  });
  const port = await listen(server);
  track(server, sockets);
  return { port, received: () => text, connections: () => count, open: () => [...sockets].length };
};

const startTlsCollector = async (collector: OtlpCollector): Promise<number> => {
  const plainPort = Number(new URL(collector.endpoint).port);
  const sockets = new Set<net.Socket>();
  const server = tls.createServer({ key: pki.key, cert: pki.cert }, (socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    const upstream = net.connect(plainPort, '127.0.0.1');
    sockets.add(upstream);
    upstream.on('error', () => socket.destroy());
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const port = await listen(server);
  track(server, sockets);
  return port;
};

const closedPort = async (): Promise<number> => {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

const proxyUrl = (port: number): string => `http://${PROXY_USER}:${PASSWORD}@127.0.0.1:${port}`;

const networkOf = (config: Partial<NetworkConfig>): OutboundNetwork => ({ config: { caFiles: [], ...config }, trust: NO_TRUST_FAILURES });

const viaProxies = (httpPort: number, httpsPort: number, noProxy?: string): OutboundNetwork =>
  networkOf({
    httpProxy: { value: proxyUrl(httpPort), source: 'HTTP_PROXY' },
    httpsProxy: { value: proxyUrl(httpsPort), source: 'network.httpsProxy' },
    ...(noProxy === undefined ? {} : { noProxy: { value: noProxy, source: 'NO_PROXY' } }),
  });

type Capturing = { exporter: SpanExporter; results: ExportResult[] };

const capturing = (inner: SpanExporter): Capturing => {
  const results: ExportResult[] = [];
  const exporter: SpanExporter = {
    export: (spans: ReadableSpan[], done: (result: ExportResult) => void) =>
      inner.export(spans, (result) => {
        results.push(result);
        done(result);
      }),
    shutdown: () => inner.shutdown(),
    ...(inner.forceFlush === undefined ? {} : { forceFlush: () => inner.forceFlush?.() ?? Promise.resolve() }),
  };
  return { exporter, results };
};

const exportOnce = async (inner: SpanExporter): Promise<ExportResult[]> => {
  const { exporter, results } = capturing(inner);
  const h = harness({ exporters: [exporter] });
  const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'momonga', agentId: 'momonga', conversationId: 'session-1', runId: RUN_ID });
  const tool = startToolSpan(h.telemetry.tracer, { toolName: 'Read', toolCallId: 'call_1', toolType: 'function', runId: RUN_ID, step: 1 }, trace.setSpan(ROOT_CONTEXT, agent));
  tool.end(h.clock.now());
  agent.end(h.clock.now());
  await h.telemetry.forceFlush();
  return results;
};

const exporterFor = (endpoint: string, network: OutboundNetwork, headers?: Record<string, string>) =>
  createOtlpTraceExporter({ endpoint, ...(headers === undefined ? {} : { headers }) }, { network, timeoutMs: EXPORT_TIMEOUT_MS });

const onlyError = (results: readonly ExportResult[]): unknown => {
  expect(results).toHaveLength(1);
  const [result] = results;
  expect(result?.error).toBeInstanceOf(Error);
  return result?.error;
};

const reportedText = (): string => reported.map((error) => `${error.message}\n${error.stack ?? ''}`).join('\n');

const expectNoSecret = (text: string): void => {
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(BASIC_CREDENTIALS);
};

beforeAll(() => {
  pki = makePki();
  installOtelErrorHandler((error) => void reported.push(error));
});

afterEach(async () => {
  tls.setDefaultCACertificates(originalCertificates);
  await Promise.all(closers.splice(0).map((close) => close()));
});

afterAll(() => {
  installOtelErrorHandler(() => undefined);
  fs.rmSync(path.dirname(pki.caFile), { recursive: true, force: true });
});

const trustTestCa = async (): Promise<void> => {
  const report = await installTrust({ caFiles: [{ value: pki.caFile, source: 'network.extraCaFiles' }] }, { readTextFile: (file) => fs.promises.readFile(file, 'utf8') });
  expect(report.failures).toEqual([]);
};

describe('the OTLP exporter follows the outbound route', { timeout: TEST_TIMEOUT_MS }, () => {
  it('tunnels an https collector export through the https proxy with CONNECT, trusting the CA installed process-wide, and keeps the collector headers inside the tunnel', async () => {
    await trustTestCa();
    const collector = await startOtlpCollector();
    registerCleanup(() => collector.close());
    const tlsPort = await startTlsCollector(collector);
    const httpProxy = await startFakeProxy({ kind: 'tunnel', targets: new Map() });
    const httpsProxy = await startFakeProxy({ kind: 'tunnel', targets: new Map([[`${COLLECTOR_HOST}:${tlsPort}`, tlsPort]]) });

    const results = await exportOnce(exporterFor(`https://${COLLECTOR_HOST}:${tlsPort}`, viaProxies(httpProxy.port, httpsProxy.port), { 'x-collector-auth': COLLECTOR_AUTH }));

    expect(results.map((result) => result.code)).toEqual([0]);
    expect(httpsProxy.received().startsWith(`CONNECT ${COLLECTOR_HOST}:${tlsPort} HTTP/1.1\r\n`)).toBe(true);
    expect(httpsProxy.received()).toContain(`Proxy-Authorization: Basic ${BASIC_CREDENTIALS}`);
    expect(httpsProxy.received()).not.toContain(COLLECTOR_AUTH);
    expect(httpProxy.connections()).toBe(0);
    expect(collector.requests[0]?.headers['x-collector-auth']).toBe(COLLECTOR_AUTH);
    expect(decodeOtlpSpans(collector.requests).map((span) => span.name).sort()).toEqual(SPAN_NAMES);
    expectNoSecret(reportedText());
  });

  it('reports a collector certificate the process does not trust as origin-certificate, through the proxy', async () => {
    const collector = await startOtlpCollector();
    registerCleanup(() => collector.close());
    const tlsPort = await startTlsCollector(collector);
    const httpsProxy = await startFakeProxy({ kind: 'tunnel', targets: new Map([[`${COLLECTOR_HOST}:${tlsPort}`, tlsPort]]) });

    const results = await exportOnce(exporterFor(`https://${COLLECTOR_HOST}:${tlsPort}`, viaProxies(await closedPort(), httpsProxy.port)));

    const labelled = findOutboundError(onlyError(results));
    expect(labelled?.hop).toBe('origin');
    expect(labelled?.failure).toMatchObject({ kind: 'origin-certificate', host: COLLECTOR_HOST });
    expect(httpsProxy.connections()).toBeGreaterThan(0);
    expect(collector.requests).toHaveLength(0);
  });

  it('exportersFor routes the configured collector through the proxy of the network it is given', async () => {
    await trustTestCa();
    const collector = await startOtlpCollector();
    registerCleanup(() => collector.close());
    const tlsPort = await startTlsCollector(collector);
    const httpsProxy = await startFakeProxy({ kind: 'tunnel', targets: new Map([[`${COLLECTOR_HOST}:${tlsPort}`, tlsPort]]) });

    const exporters = exportersFor({ otlp: { endpoint: `https://${COLLECTOR_HOST}:${tlsPort}` } }, viaProxies(await closedPort(), httpsProxy.port));
    expect(exporters).toHaveLength(1);
    const [exporter] = exporters;
    if (exporter === undefined) throw new Error('no exporter');
    const results = await exportOnce(exporter);

    expect(results.map((result) => result.code)).toEqual([0]);
    expect(httpsProxy.received().startsWith(`CONNECT ${COLLECTOR_HOST}:${tlsPort} HTTP/1.1\r\n`)).toBe(true);
    expect(decodeOtlpSpans(collector.requests).map((span) => span.name).sort()).toEqual(SPAN_NAMES);
  });
});

describe('the OTLP exporter goes direct where the route says direct', { timeout: TEST_TIMEOUT_MS }, () => {
  it('goes direct to a collector that NO_PROXY matches, and labels the direct failure as origin-connection', async () => {
    const httpProxy = await startFakeProxy({ kind: 'tunnel', targets: new Map() });
    const httpsProxy = await startFakeProxy({ kind: 'tunnel', targets: new Map() });
    const port = await closedPort();

    const results = await exportOnce(exporterFor(`https://${COLLECTOR_HOST}:${port}`, viaProxies(httpProxy.port, httpsProxy.port, COLLECTOR_HOST)));

    expect(httpProxy.connections()).toBe(0);
    expect(httpsProxy.connections()).toBe(0);
    const labelled = findOutboundError(onlyError(results));
    expect(labelled?.hop).toBe('origin');
    expect(labelled?.failure.kind).toBe('origin-connection');
    expect(labelled?.message).toContain(COLLECTOR_HOST);
  });

  it('goes direct to a loopback collector even with both proxies configured', async () => {
    const collector = await startOtlpCollector();
    registerCleanup(() => collector.close());
    const httpProxy = await startFakeProxy({ kind: 'tunnel', targets: new Map() });
    const httpsProxy = await startFakeProxy({ kind: 'tunnel', targets: new Map() });

    const results = await exportOnce(exporterFor(collector.endpoint, viaProxies(httpProxy.port, httpsProxy.port)));

    expect(results.map((result) => result.code)).toEqual([0]);
    expect(httpProxy.connections()).toBe(0);
    expect(httpsProxy.connections()).toBe(0);
    expect(decodeOtlpSpans(collector.requests).map((span) => span.name).sort()).toEqual(SPAN_NAMES);
  });

  it('goes direct when no proxy is configured, and labels the direct failure as origin-connection', async () => {
    const collector = await startOtlpCollector();
    const endpoint = collector.endpoint;
    await collector.close();

    const results = await exportOnce(exporterFor(endpoint, networkOf({})));

    const labelled = findOutboundError(onlyError(results));
    expect(labelled?.hop).toBe('origin');
    expect(labelled?.failure.kind).toBe('origin-connection');
  });
});

describe('a connection-phase failure through the proxy carries the N2 label and no secret', { timeout: TEST_TIMEOUT_MS }, () => {
  it('labels an unreachable proxy as proxy-unreachable from its source, showing the proxy without its credentials', async () => {
    const proxyPort = await closedPort();
    const before = reported.length;

    const results = await exportOnce(exporterFor(`https://${COLLECTOR_HOST}:4318`, viaProxies(await closedPort(), proxyPort)));

    const labelled = findOutboundError(onlyError(results));
    expect(labelled?.hop).toBe('proxy');
    expect(labelled?.failure).toMatchObject({ kind: 'proxy-unreachable', source: 'network.httpsProxy', proxy: `http://127.0.0.1:${proxyPort}` });
    expectNoSecret(`${labelled?.message ?? ''}\n${String(results[0]?.error)}`);
    expectNoSecret(reported.slice(before).map((error) => `${error.message}\n${error.stack ?? ''}`).join('\n'));
  });

  it('labels a 407 from the proxy as proxy-auth, not as a collector response', async () => {
    const proxy = await startFakeProxy({ kind: 'reply', text: 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="corp"\r\nContent-Length: 0\r\n\r\n' });
    const before = reported.length;

    const results = await exportOnce(exporterFor(`https://${COLLECTOR_HOST}:4318`, viaProxies(await closedPort(), proxy.port)));

    const labelled = findOutboundError(onlyError(results));
    expect(labelled?.hop).toBe('proxy');
    expect(labelled?.failure).toMatchObject({ kind: 'proxy-auth', source: 'network.httpsProxy', proxy: `http://127.0.0.1:${proxy.port}` });
    expectNoSecret(`${labelled?.message ?? ''}\n${String(results[0]?.error)}`);
    expectNoSecret(reported.slice(before).map((error) => `${error.message}\n${error.stack ?? ''}`).join('\n'));
  });

  it('labels a refused tunnel as proxy-refused with the status the proxy sent', async () => {
    const proxy = await startFakeProxy({ kind: 'reply', text: 'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n' });

    const results = await exportOnce(exporterFor(`https://${COLLECTOR_HOST}:4318`, viaProxies(await closedPort(), proxy.port)));

    const labelled = findOutboundError(onlyError(results));
    expect(labelled?.hop).toBe('proxy');
    expect(labelled?.failure).toMatchObject({ kind: 'proxy-refused', source: 'network.httpsProxy', status: 502 });
    expectNoSecret(labelled?.message ?? '');
  });
});

describe('every wait of the exporter on the proxy hop is bounded', { timeout: TEST_TIMEOUT_MS }, () => {
  it('ends an export through a proxy that accepts and never answers CONNECT within the export timeout, and closes the proxy socket', async () => {
    const proxy = await startFakeProxy({ kind: 'silent' });
    const exporter = exporterFor(`https://${COLLECTOR_HOST}:4318`, viaProxies(await closedPort(), proxy.port));

    const results = await exportOnce(exporter);

    expect(proxy.connections()).toBeGreaterThan(0);
    expect(results).toHaveLength(1);
    expect(results[0]?.code).toBe(1);
    await waitFor(() => proxy.open() === 0, { description: 'the exporter closes its socket to the silent proxy' });
    await expect(exporter.shutdown()).resolves.toBeUndefined();
  });
});
