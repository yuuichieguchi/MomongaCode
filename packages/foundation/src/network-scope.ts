import net from 'node:net';

export const NETWORK_SCOPE_KINDS = ['none', 'hosts', 'open'] as const;

export type NetworkScopeKind = (typeof NETWORK_SCOPE_KINDS)[number];

export type NetworkScope = { readonly kind: 'none' } | { readonly kind: 'hosts'; readonly hosts: readonly string[] } | { readonly kind: 'open' };

export type NetworkRequest = 'open' | { readonly hosts: readonly string[] };

export const SANDBOX_NETWORK_SETTINGS = ['deny', 'ask', 'allow'] as const;

export type SandboxNetworkSetting = (typeof SANDBOX_NETWORK_SETTINGS)[number];

export const DEFAULT_SANDBOX_NETWORK: SandboxNetworkSetting = 'ask';

export const NO_NETWORK: NetworkScope = { kind: 'none' };

export const OPEN_NETWORK: NetworkScope = { kind: 'open' };

export type HostEntry = { readonly host: string; readonly port: number | undefined };

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOST_NAME_CHARS = 253;
const MAX_PORT = 65_535;

const portOf = (text: string): number | undefined => {
  if (!/^[1-9][0-9]{0,4}$/.test(text)) return undefined;
  const port = Number(text);
  return port <= MAX_PORT ? port : undefined;
};

const isHostName = (text: string): boolean => text.length <= MAX_HOST_NAME_CHARS && text.split('.').every((label) => HOST_LABEL.test(label));

const splitHostAndPort = (text: string): { host: string; port: string | undefined } | undefined => {
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end === -1) return undefined;
    const rest = text.slice(end + 1);
    if (rest !== '' && !rest.startsWith(':')) return undefined;
    return { host: text.slice(1, end), port: rest === '' ? undefined : rest.slice(1) };
  }
  if (net.isIPv6(text)) return { host: text, port: undefined };
  const colon = text.lastIndexOf(':');
  return colon === -1 ? { host: text, port: undefined } : { host: text.slice(0, colon), port: text.slice(colon + 1) };
};

export const parseHostEntry = (text: string): HostEntry | undefined => {
  const split = splitHostAndPort(text.toLowerCase());
  if (split === undefined) return undefined;
  const port = split.port === undefined ? undefined : portOf(split.port);
  if (split.port !== undefined && port === undefined) return undefined;
  if (net.isIP(split.host) === 0 && !isHostName(split.host)) return undefined;
  return { host: split.host, port };
};

export const formatHostEntry = ({ host, port }: HostEntry): string => {
  const shown = net.isIPv6(host) && port !== undefined ? `[${host}]` : host;
  return port === undefined ? shown : `${shown}:${port}`;
};

export const hostEntryProblem = (text: string): string | undefined =>
  parseHostEntry(text) === undefined ? `${JSON.stringify(text)} is not a host name or an IP address, optionally followed by :port` : undefined;

export const normalizedHosts = (hosts: readonly string[]): string[] =>
  [
    ...new Set(
      hosts.map((text) => {
        const entry = parseHostEntry(text);
        if (entry === undefined) throw new TypeError(hostEntryProblem(text));
        return formatHostEntry(entry);
      }),
    ),
  ].sort();

export const networkScopeOfRequest = (request: NetworkRequest | undefined): NetworkScope => {
  if (request === undefined) return NO_NETWORK;
  if (request === 'open') return OPEN_NETWORK;
  return { kind: 'hosts', hosts: normalizedHosts(request.hosts) };
};

export const hostEntryCovers = (granted: HostEntry, asked: { host: string; port: number }): boolean =>
  granted.host === asked.host.toLowerCase() && (granted.port === undefined || granted.port === asked.port);

const entryWithin = (narrow: HostEntry, wide: HostEntry): boolean => narrow.host === wide.host && (wide.port === undefined || wide.port === narrow.port);

const entriesOf = (hosts: readonly string[]): HostEntry[] => normalizedHosts(hosts).map((text) => parseHostEntry(text) as HostEntry);

export const networkScopeWithin = (narrow: NetworkScope, wide: NetworkScope): boolean => {
  if (narrow.kind === 'none' || wide.kind === 'open') return true;
  if (narrow.kind === 'open' || wide.kind === 'none') return false;
  const wideEntries = entriesOf(wide.hosts);
  return entriesOf(narrow.hosts).every((entry) => wideEntries.some((candidate) => entryWithin(entry, candidate)));
};

export const meetNetworkScopes = (first: NetworkScope, second: NetworkScope): NetworkScope => {
  if (first.kind === 'none' || second.kind === 'none') return NO_NETWORK;
  if (first.kind === 'open') return second;
  if (second.kind === 'open') return first;
  const left = entriesOf(first.hosts);
  const right = entriesOf(second.hosts);
  const kept = [...left.filter((entry) => right.some((candidate) => entryWithin(entry, candidate))), ...right.filter((entry) => left.some((candidate) => entryWithin(entry, candidate)))];
  const hosts = [...new Set(kept.map(formatHostEntry))].sort();
  return hosts.length === 0 ? NO_NETWORK : { kind: 'hosts', hosts };
};

export const backendNetworkScope = (scope: NetworkScope, backend: readonly NetworkScopeKind[]): NetworkScope => (backend.includes(scope.kind) ? scope : NO_NETWORK);

export const enforcedNetworkScope = (input: { requested: NetworkScope; granted: NetworkScope; backend: readonly NetworkScopeKind[] }): NetworkScope =>
  backendNetworkScope(meetNetworkScopes(input.requested, input.granted), input.backend);

export const describeNetworkScope = (scope: NetworkScope): string => {
  switch (scope.kind) {
    case 'none':
      return 'no network access';
    case 'open':
      return 'unrestricted network access';
    case 'hosts':
      return `network access to ${scope.hosts.join(', ')} only`;
  }
};
