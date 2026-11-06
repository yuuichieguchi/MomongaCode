import { BlockList, isIP } from 'node:net';
import { isLoopbackHost, normalizedHost } from './loopback.ts';

export const NETWORK_ENV_NAMES = [
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
] as const;

export type NetworkEnvName = (typeof NETWORK_ENV_NAMES)[number];

export type NetworkSettingKey = 'network.httpProxy' | 'network.httpsProxy' | 'network.noProxy' | 'network.extraCaFiles';

export type NetworkSource = NetworkSettingKey | NetworkEnvName;

export type SourcedValue = { readonly value: string; readonly source: NetworkSource };

export type NetworkConfig = {
  readonly httpProxy?: SourcedValue;
  readonly httpsProxy?: SourcedValue;
  readonly noProxy?: SourcedValue;
  readonly caFiles: readonly SourcedValue[];
};

export type Destination = URL | { readonly socketPath: string };

export type UnsupportedProxyReason = 'scheme' | 'malformed';

export type Route =
  | { readonly kind: 'direct' }
  | { readonly kind: 'bypass'; readonly source: NetworkSource }
  | { readonly kind: 'proxy'; readonly url: URL; readonly display: string; readonly source: NetworkSource }
  | { readonly kind: 'unsupported'; readonly reason: UnsupportedProxyReason; readonly display: string; readonly message: string; readonly source: NetworkSource };

type ProxiedScheme = { readonly proxy: 'httpProxy' | 'httpsProxy'; readonly defaultPort: number };

const PROXIED_SCHEMES: Readonly<Record<string, ProxiedScheme>> = {
  'http:': { proxy: 'httpProxy', defaultPort: 80 },
  'ws:': { proxy: 'httpProxy', defaultPort: 80 },
  'https:': { proxy: 'httpsProxy', defaultPort: 443 },
  'wss:': { proxy: 'httpsProxy', defaultPort: 443 },
};

const PROXY_DEFAULT_PORTS: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443 };

const DIRECT: Route = { kind: 'direct' };

const UNSUPPORTED_TEXT = 'only http and https proxies are supported';

const DECIMAL_PORT = /^\d{1,5}$/;

type NoProxyEntry = { readonly host: string; readonly port: number | undefined } | { readonly cidr: string; readonly prefix: number };

const parsePort = (text: string): number | undefined | null => {
  if (text === '') return undefined;
  return DECIMAL_PORT.test(text) ? Number(text) : null;
};

const parseEntry = (entry: string): NoProxyEntry | null => {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']');
    if (close < 0) return null;
    const rest = entry.slice(close + 1);
    const port = rest === '' ? undefined : rest.startsWith(':') ? parsePort(rest.slice(1)) : null;
    return port === null ? null : { host: entry.slice(1, close), port };
  }
  const slash = entry.indexOf('/');
  if (slash >= 0) {
    const address = entry.slice(0, slash);
    const bits = entry.slice(slash + 1);
    const family = isIP(address);
    const limit = family === 4 ? 32 : 128;
    if (family === 0 || !/^\d{1,3}$/.test(bits) || Number(bits) > limit) return null;
    return { cidr: address, prefix: Number(bits) };
  }
  if (isIP(entry) === 6) return { host: entry, port: undefined };
  const colon = entry.lastIndexOf(':');
  if (colon < 0) return { host: entry, port: undefined };
  const port = parsePort(entry.slice(colon + 1));
  return port === null ? null : { host: entry.slice(0, colon), port };
};

const familyName = (address: string): 'ipv4' | 'ipv6' => (isIP(address) === 4 ? 'ipv4' : 'ipv6');

const sameAddress = (left: string, right: string): boolean => {
  if (isIP(left) !== isIP(right)) return false;
  const list = new BlockList();
  list.addAddress(left, familyName(left));
  return list.check(right, familyName(right));
};

const inSubnet = (cidr: string, prefix: number, address: string): boolean => {
  if (isIP(cidr) !== isIP(address)) return false;
  const list = new BlockList();
  list.addSubnet(cidr, prefix, familyName(cidr));
  return list.check(address, familyName(address));
};

const entryMatches = (entry: NoProxyEntry, host: string, port: number): boolean => {
  const hostIsAddress = isIP(host) !== 0;
  if ('cidr' in entry) return hostIsAddress && inSubnet(entry.cidr, entry.prefix, host);
  if (entry.port !== undefined && entry.port !== port) return false;
  const name = normalizedHost(entry.host);
  if (isIP(name) !== 0) return hostIsAddress && sameAddress(name, host);
  if (hostIsAddress) return false;
  const suffix = name.replace(/^\*?\./, '');
  return suffix !== '' && (host === suffix || host.endsWith(`.${suffix}`));
};

export const matchesNoProxy = (list: string, host: string, port: number): boolean => {
  const target = normalizedHost(host);
  return list
    .split(/[\s,]+/)
    .filter((entry) => entry !== '')
    .some((entry) => {
      if (entry === '*') return true;
      const parsed = parseEntry(entry);
      return parsed !== null && entryMatches(parsed, target, port);
    });
};

const proxyRoute = ({ value, source }: SourcedValue): Route => {
  if (!URL.canParse(value)) {
    return { kind: 'unsupported', reason: 'malformed', display: '<unparseable proxy URL>', message: `${source} is not a valid proxy URL; ${UNSUPPORTED_TEXT}`, source };
  }
  const url = new URL(value);
  const defaultPort = PROXY_DEFAULT_PORTS[url.protocol];
  if (defaultPort === undefined) {
    if (url.host === '') {
      return { kind: 'unsupported', reason: 'scheme', display: '<proxy URL without a scheme>', message: `${source} has no scheme; write it as http://host:port (${UNSUPPORTED_TEXT})`, source };
    }
    const display = `${url.protocol}//${url.host}`;
    return { kind: 'unsupported', reason: 'scheme', display, message: `${source} ${JSON.stringify(display)}: ${UNSUPPORTED_TEXT}`, source };
  }
  if (url.hostname === '') {
    return { kind: 'unsupported', reason: 'malformed', display: `${url.protocol}//`, message: `${source} has no proxy host; ${UNSUPPORTED_TEXT}`, source };
  }
  const port = url.port === '' ? defaultPort : Number(url.port);
  return { kind: 'proxy', url, display: `${url.protocol}//${url.hostname}:${port}`, source };
};

export const routeOf = (destination: Destination, config: NetworkConfig): Route => {
  if ('socketPath' in destination) return DIRECT;
  const scheme = PROXIED_SCHEMES[destination.protocol];
  if (scheme === undefined || isLoopbackHost(destination.hostname)) return DIRECT;
  const proxy = config[scheme.proxy];
  if (proxy === undefined) return DIRECT;
  const port = destination.port === '' ? scheme.defaultPort : Number(destination.port);
  if (config.noProxy !== undefined && matchesNoProxy(config.noProxy.value, destination.hostname, port)) return { kind: 'bypass', source: config.noProxy.source };
  return proxyRoute(proxy);
};
