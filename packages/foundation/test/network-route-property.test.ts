import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchesNoProxy, routeOf } from '@momonga/foundation';
import type { NetworkConfig, NetworkSource, Route } from '@momonga/foundation';
import { seededRandom } from './seeded-random.ts';
import type { Random } from './seeded-random.ts';

const RUNS = 2000;

const LABELS = ['api', 'corp', 'example', 'internal', 'localhost', 'git', 'a', 'svc'] as const;
const TLDS = ['com', 'org', 'internal', 'localhost', 'io'] as const;
const SCHEMES = ['http:', 'https:', 'ws:', 'wss:', 'ftp:'] as const;
const PROXY_VALUES = ['http://proxy.corp:3128', 'https://u:p@secure.corp', 'socks5://u:p@s.corp:1080', 'garbage', 'http://', '10.0.0.1:3128'] as const;
const SOURCES: readonly NetworkSource[] = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'network.httpProxy', 'network.httpsProxy'];

const octet = (random: Random): number => random.int(0, 255);

const hostOf = (random: Random): string => {
  switch (random.int(0, 4)) {
    case 0:
      return `127.${octet(random)}.${octet(random)}.${octet(random)}`;
    case 1:
      return `${random.pick([10, 172, 192, 8, 93])}.${octet(random)}.${octet(random)}.${octet(random)}`;
    case 2:
      return `[${random.pick(['::1', 'fd12::5', 'fe80::1', '2001:db8::7'])}]`;
    default: {
      const labels = Array.from({ length: random.int(1, 3) }, () => random.pick(LABELS));
      return `${labels.join('.')}.${random.pick(TLDS)}`;
    }
  }
};

const urlOf = (random: Random): URL => {
  const port = random.int(0, 2) === 0 ? `:${random.int(1, 65535)}` : '';
  return new URL(`${random.pick(SCHEMES)}//${hostOf(random)}${port}/p`);
};

const noProxyEntry = (random: Random): string => {
  switch (random.int(0, 5)) {
    case 0:
      return '*';
    case 1:
      return `.${random.pick(LABELS)}.${random.pick(TLDS)}`;
    case 2:
      return `${random.pick([10, 192, 127])}.0.0.0/${random.pick([8, 16, 24])}`;
    case 3:
      return `${hostOf(random)}:${random.pick([80, 443, 8080])}`;
    case 4:
      return 'fd00::/8';
    default:
      return hostOf(random);
  }
};

const noProxyList = (random: Random): string => Array.from({ length: random.int(0, 4) }, () => noProxyEntry(random)).join(random.pick([',', ' ', ', ']));

const configOf = (random: Random): NetworkConfig => {
  const sourced = (): { value: string; source: NetworkSource } => ({ value: random.pick(PROXY_VALUES), source: random.pick(SOURCES) });
  return {
    ...(random.int(0, 3) > 0 ? { httpProxy: sourced() } : {}),
    ...(random.int(0, 3) > 0 ? { httpsProxy: sourced() } : {}),
    ...(random.int(0, 1) === 1 ? { noProxy: { value: noProxyList(random), source: 'NO_PROXY' as const } } : {}),
    caFiles: [],
  };
};

const isLoopbackUrl = (url: URL): boolean => {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.') || host === '::1';
};

const plain = (route: Route): unknown => JSON.parse(JSON.stringify(route));

const NOT_PROXIED: readonly Route['kind'][] = ['direct', 'bypass'];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('routeOf properties', () => {
  it('is deterministic and reads nothing but its arguments (I1)', () => {
    const random = seededRandom(0x6e31);
    for (let run = 0; run < RUNS; run += 1) {
      const url = urlOf(random);
      const config = configOf(random);
      const before = JSON.stringify(config);
      vi.unstubAllEnvs();
      const first = routeOf(url, config);
      vi.stubEnv('HTTPS_PROXY', 'http://env.corp:1');
      vi.stubEnv('HTTP_PROXY', 'http://env.corp:1');
      vi.stubEnv('NO_PROXY', '*');
      const second = routeOf(url, config);
      expect(plain(second)).toEqual(plain(first));
      expect(JSON.stringify(config)).toBe(before);
    }
  });

  it('sends every loopback destination and every Unix socket direct, whatever the configuration (I2)', () => {
    const random = seededRandom(0x6e32);
    let loopbacks = 0;
    for (let run = 0; run < RUNS; run += 1) {
      const url = urlOf(random);
      const config = configOf(random);
      if (isLoopbackUrl(url)) {
        loopbacks += 1;
        expect(routeOf(url, config)).toEqual({ kind: 'direct' });
      }
      expect(routeOf({ socketPath: `/tmp/s${run}.sock` }, config)).toEqual({ kind: 'direct' });
    }
    expect(loopbacks).toBeGreaterThan(RUNS / 10);
  });

  it('never turns an unproxied route into a proxy by adding a noProxy entry (I3)', () => {
    const random = seededRandom(0x6e33);
    for (let run = 0; run < RUNS; run += 1) {
      const url = urlOf(random);
      const config = configOf(random);
      const extended: NetworkConfig = { ...config, noProxy: { value: `${config.noProxy?.value ?? ''},${noProxyEntry(random)}`, source: 'NO_PROXY' } };
      const before = routeOf(url, config).kind;
      const after = routeOf(url, extended).kind;
      if (NOT_PROXIED.includes(before)) expect(NOT_PROXIED).toContain(after);
    }
  });

  it('never proxies a loopback destination when a proxy is added (I3)', () => {
    const random = seededRandom(0x6e34);
    for (let run = 0; run < RUNS; run += 1) {
      const url = new URL(`${random.pick(SCHEMES)}//${random.pick(['localhost', '127.0.0.1', '[::1]', 'x.localhost'])}:${random.int(1, 65535)}/`);
      const config: NetworkConfig = { ...configOf(random), httpProxy: { value: 'http://proxy.corp:3128', source: 'HTTP_PROXY' }, httpsProxy: { value: 'http://proxy.corp:3128', source: 'HTTPS_PROXY' } };
      expect(routeOf(url, config)).toEqual({ kind: 'direct' });
    }
  });

  it('never shows proxy credentials in a display or a message (I7)', () => {
    const random = seededRandom(0x6e35);
    for (let run = 0; run < RUNS; run += 1) {
      const route = routeOf(urlOf(random), configOf(random));
      const shown = route.kind === 'proxy' ? route.display : route.kind === 'unsupported' ? `${route.display} ${route.message}` : '';
      expect(shown).not.toContain('u:p@');
    }
  });

  it('matches a wildcard-only list for every host and port, and an empty list for none', () => {
    const random = seededRandom(0x6e36);
    for (let run = 0; run < RUNS; run += 1) {
      const host = hostOf(random);
      const port = random.int(1, 65535);
      expect(matchesNoProxy('*', host, port)).toBe(true);
      expect(matchesNoProxy('', host, port)).toBe(false);
    }
  });
});
