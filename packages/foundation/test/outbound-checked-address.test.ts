import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo, LookupFunction } from 'node:net';
import tls from 'node:tls';
import type { TLSSocket } from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { OutboundConnectionError, createOutboundDispatcher, findOutboundError, openOutboundTunnel, outboundFetch } from '@momonga/foundation';
import type { NetworkConfig, OutboundNetwork } from '@momonga/foundation';
import { mintServerCertificate } from '../../cli/test/minted-certificates.ts';

const TEST_TIMEOUT_MS = 30_000;
const CONNECT_BOUND_MS = 2_000;
const CHECKED = '93.184.216.34';
const REBOUND = '10.0.0.1';
const TLS_NAME = 'pinned.example.test';

const minted = mintServerCertificate(TLS_NAME);
let trustBefore: string[] = [];

beforeAll(() => {
  trustBefore = tls.getCACertificates('default');
  tls.setDefaultCACertificates([...trustBefore, minted.caPem]);
});

afterAll(() => {
  tls.setDefaultCACertificates(trustBefore);
});

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const listening = async (server: net.Server): Promise<number> => {
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
};

type Origin = { port: number; hosts: string[]; names: string[] };

const seen = (origin: Omit<Origin, 'port'>): http.RequestListener => (request, response) => {
  origin.hosts.push(request.headers.host ?? '');
  const { servername } = request.socket as TLSSocket;
  if (typeof servername === 'string') origin.names.push(servername);
  response.end('from origin');
};

const startOrigin = async (): Promise<Origin> => {
  const record = { hosts: [], names: [] };
  return { ...record, port: await listening(http.createServer(seen(record))) };
};

const startTlsOrigin = async (certificate = minted): Promise<Origin> => {
  const record = { hosts: [], names: [] };
  return { ...record, port: await listening(https.createServer({ cert: certificate.certPem, key: certificate.keyPem }, seen(record))) };
};

type FakeProxy = { port: number; heads: string[] };

const HEAD_END = '\r\n\r\n';

const startProxy = async (behaviour: { tunnelTo: number } | { reply: string }): Promise<FakeProxy> => {
  const heads: string[] = [];
  const server = net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(HEAD_END);
      if (end < 0) return;
      socket.off('data', onData);
      const head = buffered.subarray(0, end).toString('latin1');
      heads.push(head);
      if ('reply' in behaviour || !head.startsWith('CONNECT ')) {
        socket.end('reply' in behaviour ? behaviour.reply : 'HTTP/1.1 200 OK\r\ncontent-length: 14\r\nconnection: close\r\n\r\nfrom the proxy');
        return;
      }
      const upstream = net.connect({ host: '127.0.0.1', port: behaviour.tunnelTo });
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
      upstream.on('close', () => socket.destroy());
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = buffered.subarray(end + HEAD_END.length);
      if (rest.length > 0) upstream.write(rest);
      socket.pipe(upstream);
      upstream.pipe(socket);
    };
    socket.on('data', onData);
  });
  return { port: await listening(server), heads };
};

const closedPort = async (): Promise<number> => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

const viaProxy = (port: number, extra: Partial<NetworkConfig> = {}, userinfo = ''): NetworkConfig => ({
  httpProxy: { value: `http://${userinfo}127.0.0.1:${port}`, source: 'HTTP_PROXY' },
  httpsProxy: { value: `http://${userinfo}127.0.0.1:${port}`, source: 'HTTPS_PROXY' },
  caFiles: [],
  ...extra,
});

const networkOf = (config: NetworkConfig): OutboundNetwork => ({ config, trust: { sources: [], failures: [] } });

const DIRECT = networkOf({ caFiles: [] });

type ChangingLookup = { lookup: LookupFunction; asked: string[] };

const lookupAnswering = (...answers: string[]): ChangingLookup => {
  const asked: string[] = [];
  const lookup = (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void): void => {
    const answer = answers[Math.min(asked.length, answers.length - 1)] as string;
    asked.push(hostname);
    const family = net.isIP(answer);
    queueMicrotask(() => {
      if (options.all === true) callback(null, [{ address: answer, family }]);
      else callback(null, answer, family);
    });
  };
  return { lookup: lookup as unknown as LookupFunction, asked };
};

const fetchThrough = (network: OutboundNetwork, lookup: LookupFunction) => {
  const dispatcher = createOutboundDispatcher(network, { connectReplyTimeoutMs: CONNECT_BOUND_MS, lookup });
  closers.push(() => dispatcher.destroy());
  return outboundFetch(dispatcher);
};

const failureOf = async (pending: Promise<unknown>): Promise<OutboundConnectionError> => {
  const error = await pending.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  const found = findOutboundError(error);
  if (found === undefined) throw new Error(`expected an outbound connection error, got ${String(error)}`);
  return found;
};

describe("a connection made under a site's lookup goes to the address that lookup answered", { timeout: TEST_TIMEOUT_MS }, () => {
  it('connects on the direct route to the address of the one resolution, and never resolves the name again', async () => {
    const origin = await startOrigin();
    const { lookup, asked } = lookupAnswering('127.0.0.1', REBOUND);

    const response = await fetchThrough(DIRECT, lookup)(`http://moving.example.test:${origin.port}/x`);

    expect(await response.text()).toBe('from origin');
    expect(asked).toEqual(['moving.example.test']);
    expect(origin.hosts).toEqual([`moving.example.test:${origin.port}`]);
  });

  it('asks the proxy for a tunnel to the checked address, and keeps the name for TLS and the Host header', async () => {
    const origin = await startTlsOrigin();
    const proxy = await startProxy({ tunnelTo: origin.port });
    const { lookup, asked } = lookupAnswering(CHECKED, REBOUND);

    const response = await fetchThrough(networkOf(viaProxy(proxy.port)), lookup)(`https://${TLS_NAME}/v1`);

    expect(await response.text()).toBe('from origin');
    expect(asked).toEqual([TLS_NAME]);
    expect(proxy.heads).toHaveLength(1);
    expect(proxy.heads[0]).toMatch(new RegExp(`^CONNECT ${CHECKED.replaceAll('.', '\\.')}:443 HTTP/1\\.1\\r\\n`));
    expect(proxy.heads[0]).not.toContain(TLS_NAME);
    expect(proxy.heads[0]).not.toContain(REBOUND);
    expect(origin.names).toEqual([TLS_NAME]);
    expect(origin.hosts).toEqual([TLS_NAME]);
  });

  it('still verifies the certificate against the name when the tunnel goes to the checked address', async () => {
    const origin = await startTlsOrigin(mintServerCertificate('another.example.test'));
    const proxy = await startProxy({ tunnelTo: origin.port });
    const { lookup } = lookupAnswering(CHECKED, REBOUND);

    const failure = await failureOf(fetchThrough(networkOf(viaProxy(proxy.port)), lookup)(`https://${TLS_NAME}/v1`));

    expect(failure.failure).toMatchObject({ kind: 'origin-certificate', host: TLS_NAME });
    expect(origin.hosts).toEqual([]);
  });

  it('asks a forwarding proxy for the checked address, with the name in the Host header', async () => {
    const proxy = await startProxy({ reply: 'HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok' });
    const { lookup, asked } = lookupAnswering(CHECKED, REBOUND);

    const response = await fetchThrough(networkOf(viaProxy(proxy.port)), lookup)('http://allowed.example.test:8080/path?q=1');

    expect(await response.text()).toBe('ok');
    expect(asked).toEqual(['allowed.example.test']);
    expect(proxy.heads[0]).toMatch(new RegExp(`^GET http://${CHECKED.replaceAll('.', '\\.')}:8080/path\\?q=1 HTTP/1\\.1\\r\\n`));
    expect(proxy.heads[0]?.toLowerCase()).toContain('\r\nhost: allowed.example.test:8080');
    expect(proxy.heads[0]).not.toContain(REBOUND);
  });

  it('writes a checked IPv6 address in brackets', async () => {
    const proxy = await startProxy({ reply: 'HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok' });
    const { lookup } = lookupAnswering('2606:2800:220:1::1946');

    await (await fetchThrough(networkOf(viaProxy(proxy.port)), lookup)('http://six.example.test/')).text();

    expect(proxy.heads[0]).toMatch(/^GET http:\/\/\[2606:2800:220:1::1946\]\/ HTTP\/1\.1\r\n/);
    expect(proxy.heads[0]?.toLowerCase()).toContain('\r\nhost: six.example.test');
  });

  it('resolves once per request through the proxy, and each request goes to the address its own resolution answered', async () => {
    const proxy = await startProxy({ reply: 'HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok' });
    const { lookup, asked } = lookupAnswering(CHECKED, '93.184.216.35');
    const fetch = fetchThrough(networkOf(viaProxy(proxy.port)), lookup);

    await (await fetch('http://twice.example.test/')).text();
    await (await fetch('http://twice.example.test/')).text();

    expect(asked).toEqual(['twice.example.test', 'twice.example.test']);
    expect(proxy.heads.map((head) => head.split(' ')[1])).toEqual([`http://${CHECKED}/`, 'http://93.184.216.35/']);
  });

  it('connects directly, never through the proxy, when the checked address is on this computer', async () => {
    const origin = await startOrigin();
    const proxy = await startProxy({ reply: 'HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok' });
    const { lookup, asked } = lookupAnswering('127.0.0.1', REBOUND);

    const response = await fetchThrough(networkOf(viaProxy(proxy.port)), lookup)(`http://here.example.test:${origin.port}/`);

    expect(await response.text()).toBe('from origin');
    expect(asked).toEqual(['here.example.test']);
    expect(proxy.heads).toEqual([]);
    expect(origin.hosts).toEqual([`here.example.test:${origin.port}`]);
  });
});

const echoServer = async (): Promise<number> => listening(net.createServer((socket) => socket.on('data', (chunk) => socket.write(`echo:${chunk.toString('utf8')}`))));

const exchanged = (socket: NodeJS.ReadWriteStream, text: string): Promise<string> =>
  new Promise((resolve, reject) => {
    socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
    socket.once('error', reject);
    socket.write(text);
  });

const BOUND = { connectReplyTimeoutMs: CONNECT_BOUND_MS } as const;

describe('a tunnel opened by the outbound factory', { timeout: TEST_TIMEOUT_MS }, () => {
  it('connects to the checked address itself when no proxy is configured', async () => {
    const port = await echoServer();

    const socket = await openOutboundTunnel(DIRECT, { host: 'echo.example.test', address: '127.0.0.1', port }, BOUND);
    closers.push(async () => void socket.destroy());

    expect(await exchanged(socket, 'hello')).toBe('echo:hello');
  });

  it('asks the configured proxy for a tunnel to the checked address, with the credentials of the proxy URL, and carries bytes both ways', async () => {
    const port = await echoServer();
    const proxy = await startProxy({ tunnelTo: port });

    const socket = await openOutboundTunnel(networkOf(viaProxy(proxy.port, {}, 'user:secret%21@')), { host: 'registry.example.test', address: CHECKED, port: 443 }, BOUND);
    closers.push(async () => void socket.destroy());

    expect(await exchanged(socket, 'hello')).toBe('echo:hello');
    expect(proxy.heads[0]).toMatch(new RegExp(`^CONNECT ${CHECKED.replaceAll('.', '\\.')}:443 HTTP/1\\.1\\r\\n`));
    expect(proxy.heads[0]).not.toContain('registry.example.test');
    expect(proxy.heads[0]?.toLowerCase()).toContain(`\r\nproxy-authorization: basic ${Buffer.from('user:secret!').toString('base64').toLowerCase()}`);
  });

  it('writes an IPv6 tunnel target in brackets', async () => {
    const proxy = await startProxy({ tunnelTo: await echoServer() });

    const socket = await openOutboundTunnel(networkOf(viaProxy(proxy.port)), { host: 'six.example.test', address: '2606:2800:220:1::1946', port: 8443 }, BOUND);
    closers.push(async () => void socket.destroy());

    expect(proxy.heads[0]).toMatch(/^CONNECT \[2606:2800:220:1::1946\]:8443 HTTP\/1\.1\r\n/);
  });

  it('connects directly when the name is exempt from the proxy', async () => {
    const port = await echoServer();
    const proxy = await startProxy({ tunnelTo: port });
    const network = networkOf(viaProxy(proxy.port, { noProxy: { value: '.corp.example.test', source: 'NO_PROXY' } }));

    const socket = await openOutboundTunnel(network, { host: 'git.corp.example.test', address: '127.0.0.1', port }, BOUND);
    closers.push(async () => void socket.destroy());

    expect(await exchanged(socket, 'hello')).toBe('echo:hello');
    expect(proxy.heads).toEqual([]);
  });

  it('connects directly when the checked address is on this computer, whatever proxy is configured', async () => {
    const port = await echoServer();
    const proxy = await startProxy({ tunnelTo: port });

    const socket = await openOutboundTunnel(networkOf(viaProxy(proxy.port)), { host: 'here.example.test', address: '127.0.0.1', port }, BOUND);
    closers.push(async () => void socket.destroy());

    expect(await exchanged(socket, 'hello')).toBe('echo:hello');
    expect(proxy.heads).toEqual([]);
  });

  it('names the proxy and its source when the proxy asks for credentials', async () => {
    const proxy = await startProxy({ reply: 'HTTP/1.1 407 Proxy Authentication Required\r\ncontent-length: 0\r\n\r\n' });

    const failure = await failureOf(openOutboundTunnel(networkOf(viaProxy(proxy.port)), { host: 'registry.example.test', address: CHECKED, port: 443 }, BOUND));

    expect(failure.failure).toEqual({ kind: 'proxy-auth', proxy: `http://127.0.0.1:${proxy.port}`, source: 'HTTPS_PROXY' });
  });

  it('names the proxy and its source when the proxy refuses the tunnel or cannot be reached', async () => {
    const refusing = await startProxy({ reply: 'HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n' });
    const target = { host: 'registry.example.test', address: CHECKED, port: 443 };

    expect((await failureOf(openOutboundTunnel(networkOf(viaProxy(refusing.port)), target, BOUND))).failure).toEqual({
      kind: 'proxy-refused',
      proxy: `http://127.0.0.1:${refusing.port}`,
      source: 'HTTPS_PROXY',
      status: 403,
    });
    const gone = await closedPort();
    expect((await failureOf(openOutboundTunnel(networkOf(viaProxy(gone)), target, BOUND))).failure).toMatchObject({ kind: 'proxy-unreachable', proxy: `http://127.0.0.1:${gone}`, source: 'HTTPS_PROXY' });
  });

  it('refuses with the sentence of an unsupported proxy', async () => {
    const network = networkOf({ httpsProxy: { value: 'socks5://127.0.0.1:1080', source: 'network.httpsProxy' }, caFiles: [] });

    const failure = await failureOf(openOutboundTunnel(network, { host: 'registry.example.test', address: CHECKED, port: 443 }, BOUND));

    expect(failure.failure).toMatchObject({ kind: 'proxy-unsupported', source: 'network.httpsProxy' });
  });

  it('labels a direct connection that fails', async () => {
    const port = await closedPort();

    const failure = await failureOf(openOutboundTunnel(DIRECT, { host: 'gone.example.test', address: '127.0.0.1', port }, BOUND));

    expect(failure.failure).toMatchObject({ kind: 'origin-connection', code: 'ECONNREFUSED' });
  });

  it('gives up when its signal is aborted before the proxy answers', async () => {
    const silent = await listening(net.createServer(() => undefined));
    const abort = new AbortController();

    const pending = openOutboundTunnel(networkOf(viaProxy(silent)), { host: 'registry.example.test', address: CHECKED, port: 443 }, { connectReplyTimeoutMs: 0, signal: abort.signal });
    const settled = pending.then(
      () => 'opened',
      () => 'refused',
    );
    setImmediate(() => abort.abort());

    expect(await settled).toBe('refused');
  });

  it('refuses an address that is not an IP literal', async () => {
    await expect(openOutboundTunnel(DIRECT, { host: 'a.example.test', address: 'b.example.test', port: 443 }, BOUND)).rejects.toThrow(TypeError);
  });
});
