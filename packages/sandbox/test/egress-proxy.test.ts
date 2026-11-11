import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { systemRandom } from '@momonga/foundation';
import type { NetworkConfig, OutboundNetwork } from '@momonga/foundation';
import { TUNNEL_OPENING_MAX_BYTES, describeEgressRefusal, startEgressProxy } from '@momonga/sandbox';
import type { EgressPorts, EgressProxy } from '@momonga/sandbox';

const closers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

type Origin = { port: number; seen: Array<{ method: string | undefined; url: string | undefined; host: string | undefined; proxyHeader: string | undefined }>; bodies: string[] };

const origin = async (): Promise<Origin> => {
  const seen: Origin['seen'] = [];
  const bodies: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push({ method: request.method, url: request.url, host: request.headers.host, proxyHeader: request.headers['proxy-connection'] as string | undefined });
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'text/plain' }).end('origin says hi');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { port: (server.address() as net.AddressInfo).port, seen, bodies };
};

const networkOf = (config: NetworkConfig): OutboundNetwork => ({ config, trust: { sources: [], failures: [] } });

const DIRECT = networkOf({ caFiles: [] });

const proxyFor = async (hosts: readonly string[], ports?: EgressPorts, network: OutboundNetwork = DIRECT): Promise<EgressProxy> => {
  const proxy = await startEgressProxy({ hosts, network, random: systemRandom, ...(ports === undefined ? {} : { ports }) });
  closers.push(() => proxy.close());
  return proxy;
};

const viaProxy = (proxy: EgressProxy, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: proxy.port, method: 'GET', path: url, headers: { host: new URL(url).host, 'proxy-authorization': proxy.authorization, ...headers }, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });

const connectVia = (proxy: EgressProxy, authority: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; socket: net.Socket }> =>
  new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: authority, headers: { 'proxy-authorization': proxy.authorization, ...headers }, agent: false });
    request.on('connect', (response, socket, head) => {
      closers.push(async () => socket.destroy());
      const status = response.statusCode ?? 0;
      if (status === 200) {
        resolve({ status, body: '', socket });
        return;
      }
      const chunks: Buffer[] = [head];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8'), socket }));
      socket.on('error', reject);
    });
    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), socket: response.socket }));
    });
    request.on('error', reject);
    request.end();
  });

const throughTunnel = (socket: net.Socket, host: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
    socket.write(`GET /through HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  });

const PUBLIC = '93.184.216.34';

type Resolver = EgressPorts & { resolved: string[] };

const resolverOf = (table: Record<string, readonly string[] | Error | ReadonlyArray<readonly string[]>>): Resolver => {
  const resolved: string[] = [];
  const asked = new Map<string, number>();
  return {
    resolved,
    resolve: async (host) => {
      resolved.push(host);
      const found = table[host];
      if (found === undefined) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
      if (found instanceof Error) throw found;
      const [first] = found;
      if (typeof first === 'string' || first === undefined) return found as readonly string[];
      const turn = asked.get(host) ?? 0;
      asked.set(host, turn + 1);
      return (found as ReadonlyArray<readonly string[]>)[Math.min(turn, found.length - 1)] as readonly string[];
    },
  };
};

type UserProxy = { port: number; heads: string[]; network: OutboundNetwork };

const HEAD_END = '\r\n\r\n';

const userProxy = async (tunnelTo: number): Promise<UserProxy> => {
  const heads: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf(HEAD_END);
      if (end < 0) return;
      socket.off('data', onData);
      const head = buffered.subarray(0, end).toString('latin1');
      heads.push(head);
      if (!head.startsWith('CONNECT ')) {
        socket.end('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 19\r\nconnection: close\r\n\r\nthe user proxy says');
        return;
      }
      const upstream = net.connect({ host: '127.0.0.1', port: tunnelTo });
      sockets.add(upstream);
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as net.AddressInfo;
  const value = `http://127.0.0.1:${port}`;
  return { port, heads, network: networkOf({ httpProxy: { value, source: 'network.httpProxy' }, httpsProxy: { value, source: 'network.httpsProxy' }, caFiles: [] }) };
};

const closedPort = async (): Promise<number> => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

const posted = (proxy: EgressProxy, url: string, body: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: proxy.port, method: 'POST', path: url, headers: { host: new URL(url).host, 'content-length': Buffer.byteLength(body), 'proxy-authorization': proxy.authorization }, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });

describe('the filtering proxy of a command with named hosts', () => {
  it('listens on a loopback port of its own and names its hosts sorted', async () => {
    const proxy = await proxyFor(['b.test', 'A.test:443']);
    expect(proxy.port).toBeGreaterThan(0);
    expect(proxy.hosts).toEqual(['a.test:443', 'b.test']);
    expect(proxy.refusals()).toEqual([]);
  });

  it('forwards a plain http request to a granted address, without the proxy headers', async () => {
    const target = await origin();
    const proxy = await proxyFor([`127.0.0.1:${target.port}`]);
    const answer = await viaProxy(proxy, `http://127.0.0.1:${target.port}/pkg?x=1`, { 'proxy-connection': 'keep-alive' });
    expect(answer).toEqual({ status: 200, body: 'origin says hi' });
    expect(target.seen).toEqual([{ method: 'GET', url: '/pkg?x=1', host: `127.0.0.1:${target.port}`, proxyHeader: undefined }]);
    expect(proxy.refusals()).toEqual([]);
  });

  it('carries the body of a forwarded request', async () => {
    const target = await origin();
    const proxy = await proxyFor([`127.0.0.1:${target.port}`]);
    expect(await posted(proxy, `http://127.0.0.1:${target.port}/publish`, 'a package body')).toEqual({ status: 200, body: 'origin says hi' });
    expect(target.seen.map((request) => request.method)).toEqual(['POST']);
    expect(target.bodies).toEqual(['a package body']);
  });

  it('opens a CONNECT tunnel to a granted address and carries the bytes both ways', async () => {
    const target = await origin();
    const proxy = await proxyFor([`127.0.0.1:${target.port}`]);
    const tunnel = await connectVia(proxy, `127.0.0.1:${target.port}`);
    expect(tunnel.status).toBe(200);
    expect(await throughTunnel(tunnel.socket, `127.0.0.1:${target.port}`)).toContain('origin says hi');
    expect(target.seen.map((request) => request.url)).toEqual(['/through']);
  });

  it('refuses a host that was not granted, with the sentence, before any name is resolved', async () => {
    const target = await origin();
    const user = await userProxy(target.port);
    const ports = resolverOf({});
    const proxy = await proxyFor(['registry.test'], ports, user.network);
    const sentence = 'the sandbox proxy refused other.test:443: it is not among the hosts this command was granted (registry.test)';
    expect(await connectVia(proxy, 'other.test:443')).toMatchObject({ status: 403, body: `${sentence}\n` });
    expect(await viaProxy(proxy, 'http://other.test/x')).toEqual({ status: 403, body: 'the sandbox proxy refused other.test:80: it is not among the hosts this command was granted (registry.test)\n' });
    expect(proxy.refusals()).toEqual([
      { kind: 'not_granted', host: 'other.test', port: 443 },
      { kind: 'not_granted', host: 'other.test', port: 80 },
    ]);
    expect(describeEgressRefusal(proxy.refusals()[0] as never, proxy.hosts)).toBe(sentence);
    expect(ports.resolved).toEqual([]);
    expect(user.heads).toEqual([]);
    expect(target.seen).toEqual([]);
  });

  it('holds a grant with a port to that port', async () => {
    const target = await origin();
    const other = await origin();
    const proxy = await proxyFor([`127.0.0.1:${target.port}`]);
    expect((await viaProxy(proxy, `http://127.0.0.1:${other.port}/`)).status).toBe(403);
    expect(other.seen).toEqual([]);
  });

  it('reaches a granted name at the address it resolves to, with the name as the host', async () => {
    const target = await origin();
    const ports = resolverOf({ 'here.test': ['127.0.0.1'] });
    const proxy = await proxyFor(['here.test', '127.0.0.1'], ports);
    expect(await viaProxy(proxy, `http://Here.test:${target.port}/pkg`)).toEqual({ status: 200, body: 'origin says hi' });
    expect(target.seen.map((request) => request.host)).toEqual([`here.test:${target.port}`]);
    const tunnel = await connectVia(proxy, `here.test:${target.port}`);
    expect(tunnel.status).toBe(200);
    expect(await throughTunnel(tunnel.socket, 'here.test')).toContain('origin says hi');
  });

  it('refuses a granted name that resolves only to addresses that are not public (I4.6)', async () => {
    const target = await origin();
    const user = await userProxy(target.port);
    const ports = resolverOf({ 'rebound.test': ['127.0.0.1', '10.0.0.5', '169.254.169.254', 'fd00::1'] });
    const proxy = await proxyFor(['rebound.test'], ports, user.network);
    const answer = await connectVia(proxy, 'rebound.test:443');
    expect(answer.status).toBe(403);
    expect(answer.body).toBe('the sandbox proxy refused rebound.test:443: the name resolves to 127.0.0.1, which is not a public address; a command reaches such an address only when the address itself is granted\n');
    expect(proxy.refusals()).toEqual([{ kind: 'guarded_address', host: 'rebound.test', port: 443, address: '127.0.0.1' }]);
    expect(user.heads).toEqual([]);
    expect(target.seen).toEqual([]);
  });

  it.each(['100.64.0.1', '198.18.0.1', '192.0.0.8', '224.0.0.1', '255.255.255.255', 'fec0::1', 'ff02::1', '::10.0.0.5', '64:ff9b::10.0.0.5', '64:ff9b:1::10.0.0.5', '2002:a00:5::1', '::ffff:a00:5'])(
    'judges %s by the one definition of the product, and refuses a name that resolves to it',
    async (address) => {
      const target = await origin();
      const user = await userProxy(target.port);
      const proxy = await proxyFor(['odd.test'], resolverOf({ 'odd.test': [address] }), user.network);
      expect((await viaProxy(proxy, 'http://odd.test/')).status).toBe(403);
      expect(proxy.refusals()).toEqual([{ kind: 'guarded_address', host: 'odd.test', port: 80, address }]);
      expect(user.heads).toEqual([]);
    },
  );

  it('reaches an address that is not public through a name when the address itself is granted', async () => {
    const target = await origin();
    const ports = resolverOf({ 'internal.test': ['127.0.0.1'] });
    const proxy = await proxyFor(['internal.test', `127.0.0.1:${target.port}`], ports);
    expect((await viaProxy(proxy, `http://internal.test:${target.port}/`)).status).toBe(200);
    expect(target.seen.map((request) => request.host)).toEqual([`internal.test:${target.port}`]);
  });

  it('reports a granted name that cannot be resolved', async () => {
    const proxy = await proxyFor(['gone.test'], resolverOf({}));
    const answer = await viaProxy(proxy, 'http://gone.test/');
    expect(answer).toEqual({ status: 502, body: 'the sandbox proxy could not reach gone.test:80: the name could not be resolved (getaddrinfo ENOTFOUND gone.test)\n' });
    expect(proxy.refusals()).toEqual([{ kind: 'unresolvable', host: 'gone.test', port: 80, cause: 'getaddrinfo ENOTFOUND gone.test' }]);
  });

  it('answers 502 with the labelled reason when the granted address does not accept the connection', async () => {
    const port = await closedPort();
    const proxy = await proxyFor([`127.0.0.1:${port}`]);
    const forwarded = await viaProxy(proxy, `http://127.0.0.1:${port}/`);
    expect(forwarded.status).toBe(502);
    expect(forwarded.body).toBe(`the sandbox proxy could not connect to 127.0.0.1:${port}: the connection to http://127.0.0.1:${port} failed before a response (ECONNREFUSED)\n`);
    const tunnelled = await connectVia(proxy, `127.0.0.1:${port}`);
    expect(tunnelled.status).toBe(502);
    expect(tunnelled.body).toContain(`the sandbox proxy could not connect to 127.0.0.1:${port}: `);
    expect(tunnelled.body).toContain('(ECONNREFUSED)');
  });

  it('answers 400 to a request that is neither an http: URL nor a CONNECT', async () => {
    const proxy = await proxyFor(['a.test']);
    expect((await viaProxy(proxy, 'ftp://a.test/file')).status).toBe(400);
    expect((await connectVia(proxy, 'a.test')).status).toBe(400);
    expect(proxy.refusals()).toEqual([]);
  });

  it('refuses a host entry that is not a host', async () => {
    await expect(startEgressProxy({ hosts: ['*.example.org'], network: DIRECT, random: systemRandom })).rejects.toThrow(TypeError);
  });

  it('ends every open tunnel and stops listening when it is closed, and closing twice is one close', async () => {
    const target = await origin();
    const proxy = await proxyFor([`127.0.0.1:${target.port}`]);
    const tunnel = await connectVia(proxy, `127.0.0.1:${target.port}`);
    const ended = new Promise<void>((resolve) => tunnel.socket.once('close', () => resolve()));
    await Promise.all([proxy.close(), proxy.close()]);
    await ended;
    await expect(viaProxy(proxy, `http://127.0.0.1:${target.port}/`)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});

describe("the filtering proxy under the user's network settings", () => {
  it("forwards a plain http request through the user's proxy, for the address it judged, with the name as the host", async () => {
    const target = await origin();
    const user = await userProxy(target.port);
    const ports = resolverOf({ 'registry.test': [PUBLIC] });
    const proxy = await proxyFor(['registry.test'], ports, user.network);
    expect(await viaProxy(proxy, 'http://Registry.test:8080/pkg?x=1')).toEqual({ status: 200, body: 'the user proxy says' });
    expect(user.heads).toHaveLength(1);
    expect(user.heads[0]).toMatch(/^GET http:\/\/93\.184\.216\.34:8080\/pkg\?x=1 HTTP\/1\.1\r\n/);
    expect(user.heads[0]?.toLowerCase()).toContain('\r\nhost: registry.test:8080');
    expect(target.seen).toEqual([]);
  });

  it("opens a CONNECT tunnel through the user's proxy to the address it judged, never to the name", async () => {
    const target = await origin();
    const user = await userProxy(target.port);
    const ports = resolverOf({ 'registry.test': [PUBLIC] });
    const proxy = await proxyFor(['registry.test'], ports, user.network);
    const tunnel = await connectVia(proxy, 'registry.test:443');
    expect(tunnel.status).toBe(200);
    expect(await throughTunnel(tunnel.socket, 'registry.test')).toContain('origin says hi');
    expect(user.heads).toHaveLength(1);
    expect(user.heads[0]).toMatch(/^CONNECT 93\.184\.216\.34:443 HTTP\/1\.1\r\n/);
    expect(user.heads[0]).not.toContain('registry.test');
  });

  it("uses the first public address when a name has both kinds, through the user's proxy", async () => {
    const target = await origin();
    const user = await userProxy(target.port);
    const proxy = await proxyFor(['mixed.test'], resolverOf({ 'mixed.test': ['10.0.0.5', PUBLIC] }), user.network);
    expect((await viaProxy(proxy, 'http://mixed.test/')).status).toBe(200);
    expect(user.heads[0]).toMatch(/^GET http:\/\/93\.184\.216\.34\/ HTTP\/1\.1\r\n/);
  });

  it("reaches a granted address on this computer directly, whatever the user's proxy", async () => {
    const target = await origin();
    const user = await userProxy(target.port);
    const proxy = await proxyFor([`127.0.0.1:${target.port}`, 'here.test'], resolverOf({ 'here.test': ['127.0.0.1'] }), user.network);
    expect(await viaProxy(proxy, `http://here.test:${target.port}/`)).toEqual({ status: 200, body: 'origin says hi' });
    expect((await connectVia(proxy, `127.0.0.1:${target.port}`)).status).toBe(200);
    expect(user.heads).toEqual([]);
  });

  it("names the user's proxy and the setting it came from when that proxy cannot be reached", async () => {
    const gone = await closedPort();
    const value = `http://127.0.0.1:${gone}`;
    const network = networkOf({ httpProxy: { value, source: 'network.httpProxy' }, httpsProxy: { value, source: 'network.httpsProxy' }, caFiles: [] });
    const proxy = await proxyFor(['registry.test'], resolverOf({ 'registry.test': [PUBLIC] }), network);
    const tunnelled = await connectVia(proxy, 'registry.test:443');
    expect(tunnelled.status).toBe(502);
    expect(tunnelled.body).toBe(`the sandbox proxy could not connect to registry.test:443: the proxy ${value} from network.httpsProxy could not be reached (ECONNREFUSED)\n`);
    const forwarded = await viaProxy(proxy, 'http://registry.test/');
    expect(forwarded.status).toBe(502);
    expect(forwarded.body).toBe(`the sandbox proxy could not connect to registry.test:80: the proxy ${value} from network.httpProxy could not be reached (ECONNREFUSED)\n`);
  });
});

describe('the address the filtering proxy judged is the address it connects to', () => {
  it("resolves a name once for a request, and a second answer of the resolver never reaches the user's proxy", async () => {
    const target = await origin();
    const user = await userProxy(target.port);
    const ports = resolverOf({ 'moving.test': [[PUBLIC], ['10.0.0.5']] });
    const proxy = await proxyFor(['moving.test'], ports, user.network);
    expect((await viaProxy(proxy, 'http://moving.test/')).status).toBe(200);
    expect(ports.resolved).toEqual(['moving.test']);
    expect(user.heads.join('\n')).not.toContain('10.0.0.5');
    expect((await connectVia(proxy, 'moving.test:443')).status).toBe(403);
    expect(ports.resolved).toEqual(['moving.test', 'moving.test']);
    expect(user.heads).toHaveLength(1);
    expect(user.heads[0]).toMatch(/^GET http:\/\/93\.184\.216\.34\/ HTTP\/1\.1\r\n/);
  });

  it('resolves a name once for a direct connection, and connects to that answer', async () => {
    const target = await origin();
    const ports = resolverOf({ 'moving.test': [['127.0.0.1'], ['10.0.0.5']] });
    const proxy = await proxyFor(['moving.test', '127.0.0.1'], ports);
    expect(await viaProxy(proxy, `http://moving.test:${target.port}/`)).toEqual({ status: 200, body: 'origin says hi' });
    expect(ports.resolved).toEqual(['moving.test']);
    expect(target.seen.map((request) => request.host)).toEqual([`moving.test:${target.port}`]);
  });
});

describe('the listener is reached only with the credential of its command', () => {
  it('answers 407 to a request or a CONNECT without the credential or with another one, and forwards with it', async () => {
    const target = await origin();
    const proxy = await proxyFor([`127.0.0.1:${target.port}`]);
    expect(proxy.url).toBe(`http://momonga:${proxy.url.slice('http://momonga:'.length, proxy.url.indexOf('@'))}@127.0.0.1:${proxy.port}`);
    expect(proxy.url.slice('http://momonga:'.length, proxy.url.indexOf('@'))).toMatch(/^[0-9a-f]{64}$/);
    expect((await viaProxy(proxy, `http://127.0.0.1:${target.port}/`, { 'proxy-authorization': '' })).status).toBe(407);
    expect((await viaProxy(proxy, `http://127.0.0.1:${target.port}/`, { 'proxy-authorization': `Basic ${Buffer.from('momonga:wrong').toString('base64')}` })).status).toBe(407);
    expect((await connectVia(proxy, `127.0.0.1:${target.port}`, { 'proxy-authorization': '' })).status).toBe(407);
    expect(await viaProxy(proxy, `http://127.0.0.1:${target.port}/`)).toEqual({ status: 200, body: 'origin says hi' });
    expect(target.seen.length).toBe(1);
  });

  it('gives each proxy its own credential', async () => {
    const first = await proxyFor(['a.test']);
    const second = await proxyFor(['a.test']);
    expect(first.authorization).not.toBe(second.authorization);
  });
});

describe('the HTTP forms the listener carries', () => {
  const upgradeOrigin = async (): Promise<number> => {
    const server = http.createServer((_request, response) => response.writeHead(426).end());
    const upgraded = new Set<net.Socket>();
    server.on('upgrade', (_request, socket: net.Socket) => {
      upgraded.add(socket);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n');
      socket.on('data', (chunk: Buffer) => socket.write(chunk));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => {
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      server.close(resolve);
    }));
    return (server.address() as net.AddressInfo).port;
  };

  const upgradeVia = (proxy: EgressProxy, url: string): Promise<{ status: number; echoed?: string }> =>
    new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port: proxy.port,
        path: url,
        headers: { host: new URL(url).host, connection: 'Upgrade', upgrade: 'echo', 'proxy-authorization': proxy.authorization },
        agent: false,
      });
      request.on('upgrade', (response, socket) => {
        closers.push(async () => socket.destroy());
        socket.once('data', (chunk: Buffer) => resolve({ status: response.statusCode ?? 0, echoed: chunk.toString('utf8') }));
        socket.write('ping');
      });
      request.on('response', (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0 });
      });
      request.on('error', reject);
      request.end();
    });

  it('carries an Upgrade request to a granted host as a tunnel', async () => {
    const port = await upgradeOrigin();
    const proxy = await proxyFor([`127.0.0.1:${port}`]);
    expect(await upgradeVia(proxy, `http://127.0.0.1:${port}/socket`)).toEqual({ status: 101, echoed: 'ping' });
  });

  it('refuses an Upgrade request to a host it was not granted', async () => {
    const port = await upgradeOrigin();
    const proxy = await proxyFor(['granted.test']);
    expect((await upgradeVia(proxy, `http://127.0.0.1:${port}/socket`)).status).toBe(403);
  });

  it('forwards a request that expects 100-continue, with its body', async () => {
    const target = await origin();
    const proxy = await proxyFor([`127.0.0.1:${target.port}`]);
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port: proxy.port,
        method: 'POST',
        path: `http://127.0.0.1:${target.port}/upload`,
        headers: { host: `127.0.0.1:${target.port}`, expect: '100-continue', 'content-length': '5', 'proxy-authorization': proxy.authorization },
        agent: false,
      });
      request.on('continue', () => request.end('hello'));
      request.on('response', (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', reject);
    });
    expect(answer.status).toBe(200);
    expect(target.bodies).toContain('hello');
  });
});

describe('a granted tunnel carries only the name it was granted for', () => {
  type Recorder = { port: number; received: () => Buffer };

  const recorder = async (): Promise<Recorder> => {
    const chunks: Buffer[] = [];
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return { port: (server.address() as net.AddressInfo).port, received: () => Buffer.concat(chunks) };
  };

  const closedAfter = (socket: net.Socket, bytes: string | Buffer): Promise<void> =>
    new Promise((resolve) => {
      socket.on('error', () => undefined);
      socket.on('close', () => resolve());
      socket.resume();
      socket.write(bytes);
    });

  const helloFor = (socket: net.Socket, servername: string | undefined): void => {
    const client = tls.connect({ socket, ...(servername === undefined ? {} : { servername }), rejectUnauthorized: false });
    client.on('error', () => undefined);
    closers.push(async () => client.destroy());
  };

  const firstBytes = async (fixture: Recorder): Promise<Buffer> => {
    for (;;) {
      const received = fixture.received();
      if (received.length > 0) return received;
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  const named = (): Promise<EgressProxy> => proxyFor(['here.test', '127.0.0.1'], resolverOf({ 'here.test': ['127.0.0.1'] }));

  it('carries a TLS ClientHello whose server name is the granted name', async () => {
    const fixture = await recorder();
    const proxy = await named();
    const tunnel = await connectVia(proxy, `here.test:${fixture.port}`);
    expect(tunnel.status).toBe(200);
    helloFor(tunnel.socket, 'Here.test');
    const received = await firstBytes(fixture);
    expect(received[0]).toBe(0x16);
    expect(received.toString('latin1')).toContain('Here.test');
    expect(proxy.refusals()).toEqual([]);
  });

  it('closes a tunnel whose ClientHello names another server, and nothing reaches the granted host', async () => {
    const fixture = await recorder();
    const proxy = await named();
    const tunnel = await connectVia(proxy, `here.test:${fixture.port}`);
    expect(tunnel.status).toBe(200);
    const closed = new Promise<void>((resolve) => tunnel.socket.on('close', () => resolve()));
    helloFor(tunnel.socket, 'fronted.test');
    await closed;
    expect(fixture.received().length).toBe(0);
    expect(proxy.refusals()).toEqual([{ kind: 'other_name', host: 'here.test', port: fixture.port, presented: 'fronted.test' }]);
    expect(describeEgressRefusal(proxy.refusals()[0] as never, proxy.hosts)).toBe(
      `the sandbox proxy closed the tunnel to here.test:${fixture.port}: it was granted for here.test, and the connection named fronted.test`,
    );
  });

  it('closes a tunnel to a name whose ClientHello carries no server name', async () => {
    const fixture = await recorder();
    const proxy = await named();
    const tunnel = await connectVia(proxy, `here.test:${fixture.port}`);
    const closed = new Promise<void>((resolve) => tunnel.socket.on('close', () => resolve()));
    helloFor(tunnel.socket, undefined);
    await closed;
    expect(fixture.received().length).toBe(0);
    expect(proxy.refusals()).toEqual([{ kind: 'other_name', host: 'here.test', port: fixture.port, presented: undefined }]);
  });

  it('closes a tunnel whose first bytes are neither TLS nor an HTTP request', async () => {
    const fixture = await recorder();
    const proxy = await named();
    const tunnel = await connectVia(proxy, `here.test:${fixture.port}`);
    await closedAfter(tunnel.socket, 'SSH-2.0-OpenSSH_9.6\r\n');
    expect(fixture.received().length).toBe(0);
    expect(proxy.refusals()).toEqual([{ kind: 'other_name', host: 'here.test', port: fixture.port, presented: undefined }]);
  });

  it('carries a plain HTTP request whose Host is the granted name, and closes one that names another host', async () => {
    const fixture = await recorder();
    const proxy = await named();
    const granted = await connectVia(proxy, `here.test:${fixture.port}`);
    granted.socket.write(`GET /socket HTTP/1.1\r\nHost: HERE.test:${fixture.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
    expect((await firstBytes(fixture)).toString('latin1')).toContain('GET /socket HTTP/1.1');
    const other = await connectVia(proxy, `here.test:${fixture.port}`);
    const before = fixture.received().length;
    await closedAfter(other.socket, `GET / HTTP/1.1\r\nHost: elsewhere.test\r\n\r\n`);
    expect(fixture.received().length).toBe(before);
    expect(proxy.refusals()).toEqual([{ kind: 'other_name', host: 'here.test', port: fixture.port, presented: 'elsewhere.test' }]);
  });

  it('carries a ClientHello without a server name to a granted address, and closes one that names a server there', async () => {
    const fixture = await recorder();
    const proxy = await proxyFor([`127.0.0.1:${fixture.port}`]);
    const plain = await connectVia(proxy, `127.0.0.1:${fixture.port}`);
    helloFor(plain.socket, undefined);
    expect((await firstBytes(fixture))[0]).toBe(0x16);
    const before = fixture.received().length;
    const naming = await connectVia(proxy, `127.0.0.1:${fixture.port}`);
    const closed = new Promise<void>((resolve) => naming.socket.on('close', () => resolve()));
    helloFor(naming.socket, 'fronted.test');
    await closed;
    expect(fixture.received().length).toBe(before);
  });

  it('closes a tunnel whose opening grows past the bound without a name', async () => {
    const fixture = await recorder();
    const proxy = await named();
    const tunnel = await connectVia(proxy, `here.test:${fixture.port}`);
    await closedAfter(tunnel.socket, `GET / HTTP/1.1\r\nX-Filler: ${'a'.repeat(TUNNEL_OPENING_MAX_BYTES)}`);
    expect(fixture.received().length).toBe(0);
  });
});
