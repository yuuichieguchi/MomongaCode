import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { describeEgressRefusal, isGuardedAddress, startEgressProxy } from '@momonga/sandbox';
import type { EgressPorts, EgressProxy } from '@momonga/sandbox';

const closers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

type Origin = { port: number; seen: Array<{ method: string | undefined; url: string | undefined; host: string | undefined; proxyHeader: string | undefined }> };

const origin = async (): Promise<Origin> => {
  const seen: Origin['seen'] = [];
  const server = http.createServer((request, response) => {
    seen.push({ method: request.method, url: request.url, host: request.headers.host, proxyHeader: request.headers['proxy-connection'] as string | undefined });
    response.writeHead(200, { 'content-type': 'text/plain' }).end('origin says hi');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { port: (server.address() as net.AddressInfo).port, seen };
};

const proxyFor = async (hosts: readonly string[], ports?: EgressPorts): Promise<EgressProxy> => {
  const proxy = await startEgressProxy({ hosts, ...(ports === undefined ? {} : { ports }) });
  closers.push(() => proxy.close());
  return proxy;
};

const viaProxy = (proxy: EgressProxy, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: proxy.port, method: 'GET', path: url, headers: { host: new URL(url).host, ...headers }, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });

const connectVia = (proxy: EgressProxy, authority: string): Promise<{ status: number; body: string; socket: net.Socket }> =>
  new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: authority, agent: false });
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

const stubPorts = (table: Record<string, readonly string[] | Error>, localPort: number): EgressPorts & { resolved: string[]; dialed: string[] } => {
  const resolved: string[] = [];
  const dialed: string[] = [];
  return {
    resolved,
    dialed,
    resolve: async (host) => {
      resolved.push(host);
      const found = table[host];
      if (found === undefined) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
      if (found instanceof Error) throw found;
      return found;
    },
    dial: (address, port) => {
      dialed.push(`${address}:${port}`);
      return net.connect({ host: '127.0.0.1', port: localPort });
    },
  };
};

describe('the address guard', () => {
  it.each(['127.0.0.1', '127.8.9.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1'])('guards %s', (address) => {
    expect(isGuardedAddress(address)).toBe(true);
  });

  it.each(['203.0.113.7', '8.8.8.8', '172.32.0.1', '2001:db8::1', '::ffff:203.0.113.7'])('does not guard %s', (address) => {
    expect(isGuardedAddress(address)).toBe(false);
  });

  it('refuses a text that is not an address', () => {
    expect(() => isGuardedAddress('example.org')).toThrow(TypeError);
  });
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

  it('opens a CONNECT tunnel to a granted address and carries the bytes both ways', async () => {
    const target = await origin();
    const proxy = await proxyFor([`127.0.0.1:${target.port}`]);
    const tunnel = await connectVia(proxy, `127.0.0.1:${target.port}`);
    expect(tunnel.status).toBe(200);
    expect(await throughTunnel(tunnel.socket, 'tunnel.test')).toContain('origin says hi');
    expect(target.seen.map((request) => request.url)).toEqual(['/through']);
  });

  it('refuses a host that was not granted, with the sentence, before any name is resolved', async () => {
    const target = await origin();
    const ports = stubPorts({}, target.port);
    const proxy = await proxyFor(['registry.test'], ports);
    const sentence = 'the sandbox proxy refused other.test:443: it is not among the hosts this command was granted (registry.test)';
    expect(await connectVia(proxy, 'other.test:443')).toMatchObject({ status: 403, body: `${sentence}\n` });
    expect(await viaProxy(proxy, 'http://other.test/x')).toEqual({ status: 403, body: 'the sandbox proxy refused other.test:80: it is not among the hosts this command was granted (registry.test)\n' });
    expect(proxy.refusals()).toEqual([
      { kind: 'not_granted', host: 'other.test', port: 443 },
      { kind: 'not_granted', host: 'other.test', port: 80 },
    ]);
    expect(describeEgressRefusal(proxy.refusals()[0] as never, proxy.hosts)).toBe(sentence);
    expect(ports.resolved).toEqual([]);
    expect(ports.dialed).toEqual([]);
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
    const ports = stubPorts({ 'registry.test': ['203.0.113.7'] }, target.port);
    const proxy = await proxyFor(['registry.test'], ports);
    expect(await viaProxy(proxy, 'http://Registry.test:8080/pkg')).toEqual({ status: 200, body: 'origin says hi' });
    expect(ports.dialed).toEqual(['203.0.113.7:8080']);
    expect(target.seen.map((request) => request.host)).toEqual(['registry.test:8080']);
    expect((await connectVia(proxy, 'registry.test:443')).status).toBe(200);
    expect(ports.dialed).toEqual(['203.0.113.7:8080', '203.0.113.7:443']);
  });

  it('refuses a granted name that resolves only to loopback, link-local or private addresses (I4.6)', async () => {
    const target = await origin();
    const ports = stubPorts({ 'rebound.test': ['127.0.0.1', '10.0.0.5', '169.254.169.254', 'fd00::1'] }, target.port);
    const proxy = await proxyFor(['rebound.test'], ports);
    const answer = await connectVia(proxy, 'rebound.test:443');
    expect(answer.status).toBe(403);
    expect(answer.body).toBe('the sandbox proxy refused rebound.test:443: the name resolves to 127.0.0.1, a loopback, link-local or private address; a command reaches such an address only when the address itself is granted\n');
    expect(proxy.refusals()).toEqual([{ kind: 'guarded_address', host: 'rebound.test', port: 443, address: '127.0.0.1' }]);
    expect(ports.dialed).toEqual([]);
  });

  it('dials the first address outside the guarded ranges when a name has both kinds', async () => {
    const target = await origin();
    const ports = stubPorts({ 'mixed.test': ['10.0.0.5', '203.0.113.9'] }, target.port);
    const proxy = await proxyFor(['mixed.test'], ports);
    expect((await viaProxy(proxy, 'http://mixed.test/')).status).toBe(200);
    expect(ports.dialed).toEqual(['203.0.113.9:80']);
  });

  it('reaches a guarded address through a name when the address itself is granted', async () => {
    const target = await origin();
    const ports = stubPorts({ 'internal.test': ['10.0.0.5'] }, target.port);
    const proxy = await proxyFor(['internal.test', '10.0.0.5'], ports);
    expect((await viaProxy(proxy, 'http://internal.test/')).status).toBe(200);
    expect(ports.dialed).toEqual(['10.0.0.5:80']);
  });

  it('reports a granted name that cannot be resolved', async () => {
    const target = await origin();
    const proxy = await proxyFor(['gone.test'], stubPorts({}, target.port));
    const answer = await viaProxy(proxy, 'http://gone.test/');
    expect(answer).toEqual({ status: 502, body: 'the sandbox proxy could not reach gone.test:80: the name could not be resolved (getaddrinfo ENOTFOUND gone.test)\n' });
    expect(proxy.refusals()).toEqual([{ kind: 'unresolvable', host: 'gone.test', port: 80, cause: 'getaddrinfo ENOTFOUND gone.test' }]);
  });

  it('answers 400 to a request that is neither an http: URL nor a CONNECT', async () => {
    const proxy = await proxyFor(['a.test']);
    expect((await viaProxy(proxy, 'ftp://a.test/file')).status).toBe(400);
    expect((await connectVia(proxy, 'a.test')).status).toBe(400);
    expect(proxy.refusals()).toEqual([]);
  });

  it('refuses a host entry that is not a host', async () => {
    await expect(startEgressProxy({ hosts: ['*.example.org'] })).rejects.toThrow(TypeError);
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
