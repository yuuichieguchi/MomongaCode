import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import { findOutboundError, installTrust } from '@momonga/foundation';
import type { NetworkConfig, OutboundNetwork, OutboundOptions, TrustReport } from '@momonga/foundation';
import { runUpdate } from '../src/commands/update.ts';
import { runBackgroundCheck } from '../src/update/background.ts';
import type { UpdateWiring } from '../src/update/background.ts';
import { UpdateError } from '../src/update/errors.ts';
import { undiciUpdateHttp } from '../src/update/node-ports.ts';
import { assetNameFor } from '../src/update/source.ts';
import { DEFAULT_SIGNATURE } from './fake-release-server.ts';
import { mintServerCertificate } from './minted-certificates.ts';
import { NEW_BINARY, OLD_BINARY, REPO, setupUpdate } from './update-harness.ts';
import type { UpdateHarness } from './update-harness.ts';

const RELEASE_HOST = 'release.example.test';
const UNRESOLVABLE_HOST = 'release.invalid';
const PASSWORD = 'proxy-password-secret';
const SHORT_BOUND_MS = 300;
const SHORT: OutboundOptions = { connectReplyTimeoutMs: SHORT_BOUND_MS, headersTimeout: SHORT_BOUND_MS, bodyTimeout: SHORT_BOUND_MS };
const TEST_TIMEOUT_MS = 10_000;
const LOOKUP_PATH = `/repos/${REPO}/releases/latest`;
const NO_TRUST_FAILURES: TrustReport = { sources: [], failures: [] };

const isExecutableDownload = (requestPath: string): boolean => requestPath.startsWith('/cdn/') && !requestPath.endsWith('/SHA256SUMS') && !requestPath.endsWith('/SHA256SUMS.sig');

type Rewrite = (requestPath: string, body: Buffer) => Buffer;

type ProxyBehaviour = {
  readonly routes: ReadonlyMap<string, number>;
  readonly silent?: boolean;
  readonly rewrite?: Rewrite;
  readonly stall?: (requestPath: string) => boolean;
};

type FakeProxy = { readonly port: number; readonly seen: string[]; connections(): number };

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

let originalTrust: string[] = [];
let scratch = '';

beforeAll(() => {
  originalTrust = tls.getCACertificates('default');
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-update-net-'));
});

afterAll(() => {
  tls.setDefaultCACertificates(originalTrust);
  fs.rmSync(scratch, { recursive: true, force: true });
});

const listening = async (server: net.Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

const trackSockets = (server: net.Server): Set<net.Socket> => {
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  return sockets;
};

const closing = (server: net.Server, sockets: Set<net.Socket>) => async (): Promise<void> => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

const forward = (behaviour: ProxyBehaviour, request: http.IncomingMessage, response: http.ServerResponse): void => {
  const target = new URL(request.url ?? '/');
  const port = behaviour.routes.get(target.hostname);
  if (port === undefined) {
    response.writeHead(502);
    response.end();
    return;
  }
  const requestPath = `${target.pathname}${target.search}`;
  const upstream = http.request({ host: '127.0.0.1', port, method: request.method, path: requestPath, headers: { ...request.headers, host: target.host } }, (reply) => {
    const chunks: Buffer[] = [];
    reply.on('data', (chunk: Buffer) => chunks.push(chunk));
    reply.on('end', () => {
      const original = Buffer.concat(chunks);
      const body = reply.statusCode === 200 && behaviour.rewrite !== undefined ? behaviour.rewrite(requestPath, original) : original;
      const { 'transfer-encoding': _chunked, connection: _connection, ...kept } = reply.headers;
      const headers = { ...kept, 'content-length': String(body.length) };
      if (reply.statusCode === 200 && behaviour.stall?.(requestPath) === true) {
        response.writeHead(200, headers);
        response.write(body.subarray(0, 1));
        return;
      }
      response.writeHead(reply.statusCode ?? 502, headers);
      response.end(body);
    });
  });
  upstream.on('error', () => response.destroy());
  request.pipe(upstream);
};

const startProxy = async (behaviour: ProxyBehaviour): Promise<FakeProxy> => {
  const seen: string[] = [];
  let connections = 0;
  const server = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    forward(behaviour, request, response);
  });
  server.on('connection', () => {
    connections += 1;
  });
  server.on('connect', (request: http.IncomingMessage, client: net.Socket) => {
    seen.push(`CONNECT ${request.url}`);
    client.on('error', () => undefined);
    if (behaviour.silent === true) return;
    const port = behaviour.routes.get((request.url ?? '').split(':')[0] ?? '');
    if (port === undefined) {
      client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = net.connect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    closers.push(async () => void upstream.destroy());
  });
  const sockets = trackSockets(server);
  const port = await listening(server);
  closers.push(closing(server, sockets));
  return { port, seen, connections: () => connections };
};

const closedPort = async (): Promise<number> => {
  const server = net.createServer();
  const port = await listening(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

const proxyUrl = (port: number): string => `http://user:${PASSWORD}@127.0.0.1:${port}`;

const proxiedConfig = (port: number, extra: Partial<NetworkConfig> = {}): NetworkConfig => ({
  httpProxy: { value: proxyUrl(port), source: 'HTTP_PROXY' },
  httpsProxy: { value: proxyUrl(port), source: 'HTTPS_PROXY' },
  caFiles: [],
  ...extra,
});

const networkOf = (config: NetworkConfig, trust: TrustReport = NO_TRUST_FAILURES): OutboundNetwork => ({ config, trust });

const releaseServerPort = (harness: UpdateHarness): number => Number(new URL(harness.server.endpoints.apiBaseUrl).port);

const through = (harness: UpdateHarness, network: OutboundNetwork, origin: string, options: OutboundOptions = SHORT): UpdateWiring => {
  harness.ports.http = undiciUpdateHttp(Promise.resolve(network), options);
  return { ...harness.wiring, endpoints: { apiBaseUrl: origin, downloadBaseUrl: origin } };
};

const run = (harness: UpdateHarness, wiring: UpdateWiring, checkOnly = false): Promise<number> =>
  runUpdate(wiring, { write: (text) => void harness.stdout.push(text) }, { checkOnly, interrupt: new AbortController().signal });

const rejection = async (pending: Promise<unknown>): Promise<UpdateError> => {
  const error: unknown = await pending.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(UpdateError);
  return error as UpdateError;
};

const publishNewRelease = (harness: UpdateHarness): string => {
  const asset = assetNameFor(harness.ports.platform, harness.ports.arch);
  harness.server.publish('v2.0.0', { [asset]: NEW_BINARY });
  return asset;
};

const startTlsReleaseServer = async (certPem: string, keyPem: string): Promise<{ port: number; hits: string[] }> => {
  const hits: string[] = [];
  const server = https.createServer({ cert: certPem, key: keyPem }, (request, response) => {
    hits.push(`${request.method} ${request.headers.host} ${request.url}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ tag_name: 'v1.0.0' }));
  });
  const sockets = trackSockets(server);
  const port = await listening(server);
  closers.push(closing(server, sockets));
  return { port, hits };
};

const writeCaFile = (pem: string): string => {
  const file = path.join(scratch, `ca-${fs.readdirSync(scratch).length}.pem`);
  fs.writeFileSync(file, pem);
  return file;
};

const fileReader = { readTextFile: (file: string): Promise<string> => fs.promises.readFile(file, 'utf8') };

describe('momonga update follows the route of the one outbound factory', { timeout: TEST_TIMEOUT_MS }, () => {
  it('sends the update check for an http release origin through the configured proxy', async (context: TestContext) => {
    const harness = await setupUpdate(context);
    harness.server.latestTag = 'v1.0.0';
    const proxy = await startProxy({ routes: new Map([[RELEASE_HOST, releaseServerPort(harness)]]) });

    const code = await run(harness, through(harness, networkOf(proxiedConfig(proxy.port)), `http://${RELEASE_HOST}`), true);

    expect(code).toBe(0);
    expect(proxy.seen).toContain(`GET http://${RELEASE_HOST}${LOOKUP_PATH}`);
    expect(harness.server.requests).toContain(`GET ${LOOKUP_PATH}`);
  });

  it('downloads and installs the release through the proxy, verifying the signature and checksum of what the proxy delivered', async (context: TestContext) => {
    const harness = await setupUpdate(context);
    const asset = publishNewRelease(harness);
    const proxy = await startProxy({ routes: new Map([[RELEASE_HOST, releaseServerPort(harness)]]) });

    const code = await run(harness, through(harness, networkOf(proxiedConfig(proxy.port)), `http://${RELEASE_HOST}`));

    expect(code).toBe(0);
    expect(harness.targetBytes().equals(NEW_BINARY)).toBe(true);
    expect(proxy.seen).toEqual(
      expect.arrayContaining([
        `GET http://${RELEASE_HOST}${LOOKUP_PATH}`,
        `GET http://${RELEASE_HOST}/${REPO}/releases/download/v2.0.0/SHA256SUMS`,
        `GET http://${RELEASE_HOST}/${REPO}/releases/download/v2.0.0/SHA256SUMS.sig`,
        `GET http://${RELEASE_HOST}/${REPO}/releases/download/v2.0.0/${asset}`,
        `GET http://${RELEASE_HOST}/cdn/v2.0.0/${asset}`,
      ]),
    );
    expect(harness.signatureChecks).toHaveLength(1);
    expect(harness.signatureChecks[0]?.signature).toBe(DEFAULT_SIGNATURE);
  });

  it('sends the background update check through the proxy', async (context: TestContext) => {
    const harness = await setupUpdate(context);
    harness.server.latestTag = 'v1.0.0';
    const proxy = await startProxy({ routes: new Map([[RELEASE_HOST, releaseServerPort(harness)]]) });

    const code = await runBackgroundCheck(through(harness, networkOf(proxiedConfig(proxy.port)), `http://${RELEASE_HOST}`), new AbortController().signal);

    expect(code).toBe(0);
    expect(proxy.seen).toContain(`GET http://${RELEASE_HOST}${LOOKUP_PATH}`);
  });

  it('tunnels an https release origin with CONNECT and trusts its certificate through a CA file installed by the N2 trust path', async (context: TestContext) => {
    const harness = await setupUpdate(context);
    const minted = mintServerCertificate(RELEASE_HOST);
    const origin = await startTlsReleaseServer(minted.certPem, minted.keyPem);
    const proxy = await startProxy({ routes: new Map([[RELEASE_HOST, origin.port]]) });
    const config = proxiedConfig(proxy.port, { caFiles: [{ value: writeCaFile(minted.caPem), source: 'network.extraCaFiles' }] });
    const trust = await installTrust(config, fileReader);
    expect(trust.failures).toEqual([]);

    const code = await run(harness, through(harness, networkOf(config, trust), `https://${RELEASE_HOST}`), true);

    expect(code).toBe(0);
    expect(proxy.seen).toContain(`CONNECT ${RELEASE_HOST}:443`);
    expect(origin.hits).toEqual([`GET ${RELEASE_HOST} ${LOOKUP_PATH}`]);
  });

  it('goes direct, never touching the proxy, when NO_PROXY matches the release host', async (context: TestContext) => {
    const harness = await setupUpdate(context);
    const proxy = await startProxy({ routes: new Map() });
    const config = proxiedConfig(proxy.port, { noProxy: { value: UNRESOLVABLE_HOST, source: 'NO_PROXY' } });

    const error = await rejection(run(harness, through(harness, networkOf(config), `https://${UNRESOLVABLE_HOST}`), true));

    expect(proxy.connections()).toBe(0);
    expect(error.code).toBe('release_lookup_failed');
    const outbound = findOutboundError(error);
    expect(outbound?.hop).toBe('origin');
    expect(outbound?.failure).toMatchObject({ kind: 'origin-connection', origin: `https://${UNRESOLVABLE_HOST}` });
  });

  it('goes direct with the labelled origin error when no proxy is configured', async (context: TestContext) => {
    const harness = await setupUpdate(context);

    const error = await rejection(run(harness, through(harness, networkOf({ caFiles: [] }), `https://${UNRESOLVABLE_HOST}`), true));

    expect(error.code).toBe('release_lookup_failed');
    expect(error.message.startsWith(`looking up the latest release failed: the connection to https://${UNRESOLVABLE_HOST} failed before a response`)).toBe(true);
    expect(findOutboundError(error)?.failure.kind).toBe('origin-connection');
  });
});

describe('momonga update reports connection-phase failures with the N2 label and no proxy credential', { timeout: TEST_TIMEOUT_MS }, () => {
  it('names an unreachable proxy and its source in the English update message, without the password', async (context: TestContext) => {
    const harness = await setupUpdate(context);
    const port = await closedPort();

    const error = await rejection(run(harness, through(harness, networkOf(proxiedConfig(port)), `https://${RELEASE_HOST}`), true));

    expect(error.code).toBe('release_lookup_failed');
    expect(error.message.startsWith(`looking up the latest release failed: the proxy http://127.0.0.1:${port} from HTTPS_PROXY could not be reached`)).toBe(true);
    expect(findOutboundError(error)?.hop).toBe('proxy');
    expect(findOutboundError(error)?.failure).toMatchObject({ kind: 'proxy-unreachable', source: 'HTTPS_PROXY', proxy: `http://127.0.0.1:${port}` });
    expect(`${error.message} ${error.detail ?? ''}`).not.toContain(PASSWORD);
    expect(`${error.message} ${error.detail ?? ''}`).not.toContain('user:');
  });

  it('ends a CONNECT the proxy never answers within the update bound, labelled as the proxy hop', async (context: TestContext) => {
    const harness = await setupUpdate(context);
    const proxy = await startProxy({ routes: new Map(), silent: true });

    const error = await rejection(run(harness, through(harness, networkOf(proxiedConfig(proxy.port)), `https://${RELEASE_HOST}`), true));

    expect(proxy.seen).toContain(`CONNECT ${RELEASE_HOST}:443`);
    expect(error.code).toBe('release_lookup_failed');
    expect(findOutboundError(error)?.failure).toMatchObject({ kind: 'proxy-unreachable', source: 'HTTPS_PROXY' });
    expect(error.message).not.toContain(PASSWORD);
  });

  it('refuses every https connection to the release host while a configured CA file is not loaded, naming the file and its source', async (context: TestContext) => {
    const harness = await setupUpdate(context);
    const proxy = await startProxy({ routes: new Map([[RELEASE_HOST, releaseServerPort(harness)]]) });
    const missing = path.join(scratch, 'missing-ca.pem');
    const config = proxiedConfig(proxy.port, { caFiles: [{ value: missing, source: 'network.extraCaFiles' }] });
    const trust = await installTrust(config, fileReader);
    const wiring = through(harness, networkOf(config, trust), `https://${RELEASE_HOST}`);

    const first = await rejection(run(harness, wiring, true));
    const second = await rejection(run(harness, wiring, true));

    for (const error of [first, second]) {
      expect(error.code).toBe('release_lookup_failed');
      expect(findOutboundError(error)?.failure).toMatchObject({ kind: 'ca-file', file: missing, source: 'network.extraCaFiles' });
      expect(error.message).toContain(`the CA file ${missing} from network.extraCaFiles was not loaded`);
    }
    expect(proxy.connections()).toBe(0);
  });
});

describe('momonga update keeps its bound and its verification through a proxy', { timeout: TEST_TIMEOUT_MS }, () => {
  it('ends a release body that stalls behind the proxy within the update bound and installs nothing', async (context: TestContext) => {
    const harness = await setupUpdate(context);
    publishNewRelease(harness);
    const proxy = await startProxy({ routes: new Map([[RELEASE_HOST, releaseServerPort(harness)]]), stall: isExecutableDownload });

    const error = await rejection(run(harness, through(harness, networkOf(proxiedConfig(proxy.port)), `http://${RELEASE_HOST}`)));

    expect(error.code).toBe('download_failed');
    expect(error.message.startsWith('downloading the release executable was interrupted:')).toBe(true);
    expect(harness.targetBytes().equals(OLD_BINARY)).toBe(true);
    expect(harness.directoryEntries()).toEqual(['momonga']);
  });

  it('refuses an executable the proxy altered, by its sha256', async (context: TestContext) => {
    const harness = await setupUpdate(context);
    publishNewRelease(harness);
    const altered = Buffer.from('altered-binary-bytes-from-the-proxy');
    const proxy = await startProxy({
      routes: new Map([[RELEASE_HOST, releaseServerPort(harness)]]),
      rewrite: (requestPath, body) => (isExecutableDownload(requestPath) ? altered : body),
    });

    const error = await rejection(run(harness, through(harness, networkOf(proxiedConfig(proxy.port)), `http://${RELEASE_HOST}`)));

    expect(proxy.seen.some((line) => line.startsWith(`GET http://${RELEASE_HOST}/cdn/`))).toBe(true);
    expect(error.code).toBe('checksum_mismatch');
    expect(harness.targetBytes().equals(OLD_BINARY)).toBe(true);
    expect(harness.directoryEntries()).toEqual(['momonga']);
  });

  it('verifies the signature the proxy delivered and refuses the release when it does not verify', async (context: TestContext) => {
    const harness = await setupUpdate(context);
    publishNewRelease(harness);
    const forged = '-----BEGIN SSH SIGNATURE-----\nforged-by-the-proxy\n-----END SSH SIGNATURE-----\n';
    harness.control.signature = { exitCode: 255, stdout: '', stderr: 'Signature verification failed\n' };
    const proxy = await startProxy({
      routes: new Map([[RELEASE_HOST, releaseServerPort(harness)]]),
      rewrite: (requestPath, body) => (requestPath.endsWith('SHA256SUMS.sig') ? Buffer.from(forged) : body),
    });

    const error = await rejection(run(harness, through(harness, networkOf(proxiedConfig(proxy.port)), `http://${RELEASE_HOST}`)));

    expect(harness.signatureChecks.map((check) => check.signature)).toEqual([forged]);
    expect(error.code).toBe('signature_rejected');
    expect(harness.targetBytes().equals(OLD_BINARY)).toBe(true);
  });
});
