import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { formatHostEntry, hostEntryCovers, normalizedHosts, parseHostEntry } from '@momonga/foundation';
import type { HostEntry } from '@momonga/foundation';
import { isGuardedAddress } from './address-guard.ts';

export type EgressRefusal =
  | { readonly kind: 'not_granted'; readonly host: string; readonly port: number }
  | { readonly kind: 'guarded_address'; readonly host: string; readonly port: number; readonly address: string }
  | { readonly kind: 'unresolvable'; readonly host: string; readonly port: number; readonly cause: string };

export type EgressPorts = {
  resolve(host: string): Promise<readonly string[]>;
  dial(address: string, port: number): net.Socket;
};

export type EgressProxy = {
  readonly port: number;
  readonly hosts: readonly string[];
  refusals(): readonly EgressRefusal[];
  close(): Promise<void>;
};

export const EGRESS_PROXY_HOST = '127.0.0.1';

export const nodeEgressPorts: EgressPorts = {
  resolve: async (host) => (await dns.promises.lookup(host, { all: true })).map((found) => found.address),
  dial: (address, port) => net.connect({ host: address, port }),
};

export const describeEgressRefusal = (refusal: EgressRefusal, hosts: readonly string[]): string => {
  const target = formatHostEntry({ host: refusal.host, port: refusal.port });
  switch (refusal.kind) {
    case 'not_granted':
      return `the sandbox proxy refused ${target}: it is not among the hosts this command was granted (${hosts.join(', ')})`;
    case 'guarded_address':
      return `the sandbox proxy refused ${target}: the name resolves to ${refusal.address}, a loopback, link-local or private address; a command reaches such an address only when the address itself is granted`;
    case 'unresolvable':
      return `the sandbox proxy could not reach ${target}: the name could not be resolved (${refusal.cause})`;
  }
};

class DialingAgent extends http.Agent {
  readonly #dial: () => net.Socket;

  constructor(dial: () => net.Socket) {
    super({ keepAlive: false });
    this.#dial = dial;
  }

  override createConnection(): net.Socket {
    return this.#dial();
  }
}

const HOP_BY_HOP: ReadonlySet<string> = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

const forwardedHeaders = (headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders =>
  Object.fromEntries(Object.entries(headers).filter(([name, value]) => !HOP_BY_HOP.has(name) && value !== undefined));

const statusText = (status: number): string => http.STATUS_CODES[status] ?? '';

const rawResponse = (status: number, body: string): string =>
  `HTTP/1.1 ${status} ${statusText(status)}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(`${body}\n`)}\r\nConnection: close\r\n\r\n${body}\n`;

type Target = { host: string; port: number };

const targetOfAuthority = (authority: string | undefined): Target | undefined => {
  const entry = authority === undefined ? undefined : parseHostEntry(authority);
  return entry === undefined || entry.port === undefined ? undefined : { host: entry.host, port: entry.port };
};

const targetOfUrl = (text: string | undefined): (Target & { path: string; authority: string }) | undefined => {
  if (text === undefined || !URL.canParse(text)) return undefined;
  const url = new URL(text);
  if (url.protocol !== 'http:') return undefined;
  const entry = parseHostEntry(url.host);
  if (entry === undefined) return undefined;
  return { host: entry.host, port: entry.port ?? 80, path: `${url.pathname}${url.search}`, authority: url.host };
};

export const startEgressProxy = async (options: { hosts: readonly string[]; ports?: EgressPorts }): Promise<EgressProxy> => {
  const ports = options.ports ?? nodeEgressPorts;
  const hosts = normalizedHosts(options.hosts);
  const granted = hosts.map((text) => parseHostEntry(text) as HostEntry);
  const refused: EgressRefusal[] = [];
  const failures: unknown[] = [];
  const open = new Set<Duplex>();
  let closed = false;

  const track = <S extends Duplex>(socket: S): S => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    return socket;
  };

  const covers = (target: Target): boolean => granted.some((entry) => hostEntryCovers(entry, target));

  const admit = async ({ host, port }: Target): Promise<{ address: string } | EgressRefusal> => {
    if (!covers({ host, port })) return { kind: 'not_granted', host, port };
    if (net.isIP(host) !== 0) return { address: host };
    let addresses: readonly string[];
    try {
      addresses = await ports.resolve(host);
    } catch (error) {
      return { kind: 'unresolvable', host, port, cause: error instanceof Error ? error.message : String(error) };
    }
    const [first] = addresses;
    if (first === undefined) return { kind: 'unresolvable', host, port, cause: 'no address' };
    const usable = addresses.find((address) => !isGuardedAddress(address) || covers({ host: address, port }));
    return usable === undefined ? { kind: 'guarded_address', host, port, address: first } : { address: usable };
  };

  const refuse = (refusal: EgressRefusal): string => {
    refused.push(refusal);
    return describeEgressRefusal(refusal, hosts);
  };

  const statusOf = (refusal: EgressRefusal): number => (refusal.kind === 'unresolvable' ? 502 : 403);

  const tunnel = async (target: Target, client: Duplex, head: Buffer): Promise<void> => {
    const admitted = await admit(target);
    if (closed) return;
    if ('kind' in admitted) {
      client.end(rawResponse(statusOf(admitted), refuse(admitted)));
      return;
    }
    const upstream = track(ports.dial(admitted.address, target.port));
    let established = false;
    upstream.once('connect', () => {
      established = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', (error) => {
      if (established) client.destroy();
      else client.end(rawResponse(502, `the sandbox proxy could not connect to ${formatHostEntry(target)}: ${error.message}`));
    });
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  };

  const forward = async (target: Target & { path: string; authority: string }, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    const admitted = await admit(target);
    if (closed) return;
    if ('kind' in admitted) {
      response.writeHead(statusOf(admitted), { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(`${refuse(admitted)}\n`);
      return;
    }
    const outgoing = http.request({
      method: request.method,
      path: target.path,
      headers: { ...forwardedHeaders(request.headers), host: target.authority, connection: 'close' },
      agent: new DialingAgent(() => track(ports.dial(admitted.address, target.port))),
    });
    outgoing.on('response', (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, forwardedHeaders(incoming.headers));
      incoming.pipe(response);
    });
    outgoing.on('error', (error) => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(`the sandbox proxy could not connect to ${formatHostEntry(target)}: ${error.message}\n`);
    });
    request.pipe(outgoing);
  };

  const guard = (work: Promise<void>, client: { destroy(): unknown }): void => {
    work.catch((error: unknown) => {
      failures.push(error);
      client.destroy();
    });
  };

  const server = http.createServer();
  server.on('connection', (socket) => track(socket));
  server.on('connect', (request: http.IncomingMessage, client: Duplex, head: Buffer) => {
    client.on('error', () => undefined);
    const target = targetOfAuthority(request.url);
    if (target === undefined) {
      client.end(rawResponse(400, `the sandbox proxy needs a CONNECT target of the form host:port, got ${JSON.stringify(request.url)}`));
      return;
    }
    guard(tunnel(target, client, head), client);
  });
  server.on('request', (request, response) => {
    const target = targetOfUrl(request.url);
    if (target === undefined) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end('the sandbox proxy forwards requests for http: URLs and CONNECT tunnels only\n');
      return;
    }
    guard(forward(target, request, response), response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, EGRESS_PROXY_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      closed = true;
      const ended = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of open) socket.destroy();
      await ended;
      const [failure] = failures;
      if (failure !== undefined) throw failure;
    })();
    return closing;
  };

  return { port: (server.address() as AddressInfo).port, hosts, refusals: () => [...refused], close };
};
