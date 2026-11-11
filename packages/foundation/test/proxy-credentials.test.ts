import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'undici';
import { createOutboundDispatcher, proxyPasswordsOf, redactedUrl, routeOf } from '@momonga/foundation';
import { proxyCredentialsOf } from '../src/network-route.ts';
import type { NetworkConfig } from '@momonga/foundation';

const TEST_TIMEOUT_MS = 30_000;
const CONNECT_BOUND_MS = 5_000;

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const startRefusingProxy = async (): Promise<{ port: number; received: () => string }> => {
  let text = '';
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1');
      if (text.includes('\r\n\r\n') && socket.writable) socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { port: (server.address() as AddressInfo).port, received: () => text };
};

const configWith = (proxy: string): NetworkConfig => ({ httpsProxy: { value: proxy, source: 'HTTPS_PROXY' }, caFiles: [] });

const basic = (pair: string): string => `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;

describe('proxy URL user info is decoded once, tolerantly', { timeout: TEST_TIMEOUT_MS }, () => {
  it('keeps a % that starts no escape and decodes a valid escape once', () => {
    expect(proxyCredentialsOf(new URL('http://user:100%@proxy:8080'))).toEqual({ username: 'user', password: '100%' });
    expect(proxyCredentialsOf(new URL('http://us%40er:p%40ss%2540@proxy:8080'))).toEqual({ username: 'us@er', password: 'p@ss%40' });
    expect(proxyCredentialsOf(new URL('http://user:%80%zz@proxy:8080')).password).toBe('�%zz');
  });

  it('routes a URL whose password holds a bare % through the proxy', () => {
    const route = routeOf(new URL('https://model.example.test/'), configWith('http://user:100%@proxy:8080'));
    expect(route.kind).toBe('proxy');
  });

  it('lists the decoded password and its Basic token for redaction', () => {
    const listed = proxyPasswordsOf(configWith('http://user:100%@proxy:8080')).map(({ password }) => password);
    expect(listed).toContain('100%');
    expect(listed).toContain(Buffer.from('user:100%').toString('base64'));
  });

  it('sends the Basic header of the decoded pair to the proxy', async () => {
    const proxy = await startRefusingProxy();
    const dispatcher = createOutboundDispatcher({ config: configWith(`http://user:100%@127.0.0.1:${proxy.port}`), trust: { sources: [], failures: [] } }, { connectReplyTimeoutMs: CONNECT_BOUND_MS });
    closers.push(() => dispatcher.destroy());

    await request('https://model.example.test/', { dispatcher }).then(
      () => undefined,
      () => undefined,
    );

    expect(proxy.received().toLowerCase()).toContain(`\r\nproxy-authorization: ${basic('user:100%').toLowerCase()}`);
  });

  it('lists for redaction exactly the token it sends for a user name without a password, and no error text carries it', async () => {
    const proxy = await startRefusingProxy();
    const config = configWith(`http://user@127.0.0.1:${proxy.port}`);
    const token = Buffer.from('user:').toString('base64');
    const dispatcher = createOutboundDispatcher({ config, trust: { sources: [], failures: [] } }, { connectReplyTimeoutMs: CONNECT_BOUND_MS });
    closers.push(() => dispatcher.destroy());

    const error = await request('https://model.example.test/', { dispatcher }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(proxy.received().toLowerCase()).toContain(`\r\nproxy-authorization: basic ${token.toLowerCase()}`);
    expect(proxyPasswordsOf(config).map(({ password }) => password)).toContain(token);
    expect(String((error as Error).message)).not.toContain(token);
    expect(redactedUrl(config.httpsProxy?.value ?? '')).not.toContain('user');
  });
});
