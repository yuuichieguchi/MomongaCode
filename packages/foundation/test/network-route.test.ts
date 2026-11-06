import { describe, expect, it } from 'vitest';
import { isLoopbackHost, matchesNoProxy, NETWORK_ENV_NAMES, routeOf } from '@momonga/foundation';
import type { NetworkConfig } from '@momonga/foundation';

const PROXY = 'http://user:secret@proxy.corp:3128';

const withProxy = (overrides: Partial<NetworkConfig> = {}): NetworkConfig => ({
  httpProxy: { value: PROXY, source: 'HTTP_PROXY' },
  httpsProxy: { value: PROXY, source: 'HTTPS_PROXY' },
  caFiles: [],
  ...overrides,
});

const NONE: NetworkConfig = { caFiles: [] };

describe('NETWORK_ENV_NAMES', () => {
  it('lists the standard proxy and CA variables in both cases, in the precedence order', () => {
    expect(NETWORK_ENV_NAMES).toEqual([
      'https_proxy',
      'HTTPS_PROXY',
      'http_proxy',
      'HTTP_PROXY',
      'all_proxy',
      'ALL_PROXY',
      'no_proxy',
      'NO_PROXY',
      'SSL_CERT_FILE',
      'NODE_EXTRA_CA_CERTS',
    ]);
  });
});

describe('isLoopbackHost', () => {
  it.each(['localhost', 'LOCALHOST', 'localhost.', 'ollama.localhost', 'a.b.localhost', '127.0.0.1', '127.255.255.254', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '[::ffff:7f00:1]'])(
    'treats %s as loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(['localhost.example.com', 'notlocalhost', '128.0.0.1', '127.0.0.256', '10.0.0.1', '::2', 'example.com', ''])('does not treat %s as loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('matchesNoProxy', () => {
  it.each([
    ['*', 'api.example.com', 443],
    ['example.com', 'example.com', 443],
    ['example.com', 'api.example.com', 443],
    ['.example.com', 'api.example.com', 443],
    ['*.example.com', 'api.example.com', 443],
    ['EXAMPLE.com', 'Api.Example.COM', 443],
    ['example.com.', 'api.example.com', 443],
    ['example.com', 'api.example.com.', 443],
    ['10.1.2.3', '10.1.2.3', 80],
    ['10.0.0.0/8', '10.20.30.40', 443],
    ['192.168.0.0/16', '192.168.7.9', 443],
    ['fd00::/8', 'fd12::5', 443],
    ['fd00::/8', '[fd12::5]', 443],
    ['::5', '[::5]', 443],
    ['[::5]', '::5', 443],
    ['example.com:8443', 'example.com', 8443],
    ['[fd12::5]:8443', 'fd12::5', 8443],
    ['other.org, example.com', 'example.com', 443],
    ['other.org example.com', 'example.com', 443],
    ['other.org,\texample.com\n', 'example.com', 443],
  ])('entry list %j matches %s:%i', (list, host, port) => {
    expect(matchesNoProxy(list, host, port)).toBe(true);
  });

  it.each([
    ['', 'example.com', 443],
    ['   ,  ', 'example.com', 443],
    ['example.com', 'badexample.com', 443],
    ['.example.com', 'myexample.com', 443],
    ['api.example.com', 'example.com', 443],
    ['10.0.0.0/8', '11.0.0.1', 443],
    ['10.0.0.0/8', 'ten.example.com', 443],
    ['example.com:8443', 'example.com', 443],
    ['10.1.2.3', '10.1.2.4', 443],
    ['fd00::/8', 'fe80::1', 443],
    ['10.0.0.0/33', '10.0.0.1', 443],
    ['bad/8', 'bad', 443],
  ])('entry list %j does not match %s:%i', (list, host, port) => {
    expect(matchesNoProxy(list, host, port)).toBe(false);
  });
});

describe('routeOf', () => {
  it('is direct when no proxy is configured', () => {
    expect(routeOf(new URL('https://api.example.com/v1'), NONE)).toEqual({ kind: 'direct' });
    expect(routeOf(new URL('http://api.example.com/v1'), NONE)).toEqual({ kind: 'direct' });
  });

  it('sends https destinations to the https proxy and http destinations to the http proxy', () => {
    const config = withProxy({ httpProxy: { value: 'http://plain.corp:8080', source: 'network.httpProxy' }, httpsProxy: { value: 'https://secure.corp', source: 'network.httpsProxy' } });
    expect(routeOf(new URL('https://api.example.com/'), config)).toMatchObject({ kind: 'proxy', source: 'network.httpsProxy', display: 'https://secure.corp:443' });
    expect(routeOf(new URL('http://api.example.com/'), config)).toMatchObject({ kind: 'proxy', source: 'network.httpProxy', display: 'http://plain.corp:8080' });
  });

  it('maps ws to the http proxy and wss to the https proxy', () => {
    const config = withProxy({ httpProxy: { value: 'http://plain.corp:8080', source: 'HTTP_PROXY' }, httpsProxy: { value: 'http://secure.corp:8443', source: 'HTTPS_PROXY' } });
    expect(routeOf(new URL('ws://api.example.com/'), config)).toMatchObject({ kind: 'proxy', source: 'HTTP_PROXY' });
    expect(routeOf(new URL('wss://api.example.com/'), config)).toMatchObject({ kind: 'proxy', source: 'HTTPS_PROXY' });
  });

  it('is direct for a scheme that no proxy serves', () => {
    expect(routeOf(new URL('ftp://files.example.com/'), withProxy())).toEqual({ kind: 'direct' });
  });

  it('keeps the credentials in the proxy URL and out of the display', () => {
    const route = routeOf(new URL('https://api.example.com/'), withProxy());
    if (route.kind !== 'proxy') throw new Error(`expected a proxy route, got ${route.kind}`);
    expect(route.url.username).toBe('user');
    expect(route.url.password).toBe('secret');
    expect(route.display).toBe('http://proxy.corp:3128');
  });

  it.each(['http://localhost:11434/api', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080/', 'http://ollama.localhost/', 'https://127.9.9.9/'])('never proxies loopback destination %s', (raw) => {
    expect(routeOf(new URL(raw), withProxy())).toEqual({ kind: 'direct' });
  });

  it('never proxies a Unix socket', () => {
    expect(routeOf({ socketPath: '/tmp/momonga.sock' }, withProxy())).toEqual({ kind: 'direct' });
  });

  it('bypasses the proxy for a destination that noProxy matches, naming the source', () => {
    const config = withProxy({ noProxy: { value: '.corp.internal, 10.0.0.0/8', source: 'NO_PROXY' } });
    expect(routeOf(new URL('https://git.corp.internal/'), config)).toEqual({ kind: 'bypass', source: 'NO_PROXY' });
    expect(routeOf(new URL('http://10.4.5.6:8000/'), config)).toEqual({ kind: 'bypass', source: 'NO_PROXY' });
    expect(routeOf(new URL('https://api.example.com/'), config)).toMatchObject({ kind: 'proxy' });
  });

  it('matches noProxy ports against the scheme default port when the URL has none', () => {
    const config = withProxy({ noProxy: { value: 'api.example.com:443', source: 'network.noProxy' } });
    expect(routeOf(new URL('https://api.example.com/'), config)).toEqual({ kind: 'bypass', source: 'network.noProxy' });
    expect(routeOf(new URL('https://api.example.com:8443/'), config)).toMatchObject({ kind: 'proxy' });
    expect(routeOf(new URL('http://api.example.com/'), config)).toMatchObject({ kind: 'proxy' });
  });

  it.each([
    ['socks5://proxy.corp:1080', 'scheme'],
    ['socks5h://u:secret@proxy.corp:1080', 'scheme'],
    ['proxy.corp:3128', 'scheme'],
    ['10.0.0.1:3128', 'malformed'],
    ['http://', 'malformed'],
    ['not a url at all', 'malformed'],
  ] as const)('reports proxy %s as unsupported (%s) with its source, never as direct', (value, reason) => {
    const config: NetworkConfig = { httpsProxy: { value, source: 'HTTPS_PROXY' }, caFiles: [] };
    const route = routeOf(new URL('https://api.example.com/'), config);
    expect(route).toMatchObject({ kind: 'unsupported', reason, source: 'HTTPS_PROXY' });
    if (route.kind !== 'unsupported') throw new Error('unreachable');
    expect(route.message).toContain('HTTPS_PROXY');
    expect(route.message).toContain('only http and https proxies are supported');
    expect(route.message).not.toContain('secret');
  });

  it('does not report a broken proxy for a destination that bypasses it', () => {
    const config: NetworkConfig = {
      httpProxy: { value: 'socks5://proxy.corp:1080', source: 'ALL_PROXY' },
      httpsProxy: { value: 'garbage', source: 'ALL_PROXY' },
      noProxy: { value: 'internal.example', source: 'NO_PROXY' },
      caFiles: [],
    };
    expect(routeOf(new URL('http://127.0.0.1:11434/'), config)).toEqual({ kind: 'direct' });
    expect(routeOf({ socketPath: '/run/x.sock' }, config)).toEqual({ kind: 'direct' });
    expect(routeOf(new URL('https://api.internal.example/'), config)).toEqual({ kind: 'bypass', source: 'NO_PROXY' });
  });
});
