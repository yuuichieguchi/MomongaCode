import { sha256Hex } from '@momonga/foundation';
import { GENERIC_SERVER_KIND, MANAGED_SERVERS, PROVIDER_NAME_PATTERN, SERVER_ADAPTER_LABELS } from '@momonga/protocol';
import type { ServerKind, ServerKinds } from '@momonga/protocol';

export type ProviderNameInput = {
  provider?: string | undefined;
  adapter: string;
  baseUrl?: string | undefined;
  socketPath?: string | undefined;
  plan?: { profile: string; account?: string | undefined } | undefined;
  server?: string | undefined;
};

const SOCKET_HASH_CHARS = 8;
const SOCKET_SEGMENT_CHARS = 32;
const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' };

const mapped = (text: string): string => text.replace(/[^a-z0-9.-]/g, '-');

const socketName = (socketPath: string): string => {
  const segment = socketPath.slice(socketPath.lastIndexOf('/') + 1).toLowerCase().slice(0, SOCKET_SEGMENT_CHARS);
  return `sock-${sha256Hex(socketPath).slice(0, SOCKET_HASH_CHARS)}-${mapped(segment)}`;
};

type NetworkAddress = { host: string; port: string; ipv6: boolean };

const networkAddressOf = (baseUrl: string): NetworkAddress => {
  const url = new URL(baseUrl);
  const ipv6 = url.hostname.startsWith('[');
  const port = url.port === '' ? DEFAULT_PORTS[url.protocol] : url.port;
  if (port === undefined) throw new TypeError(`the address ${baseUrl} has no port a server name can be made from`);
  return { host: ipv6 ? url.hostname.slice(1, -1) : url.hostname, port, ipv6 };
};

const addressName = (connection: ProviderNameInput, prefix: { network: string; network6: string; socket: string }): string => {
  if (connection.baseUrl !== undefined) {
    const { host, port, ipv6 } = networkAddressOf(connection.baseUrl);
    return `${ipv6 ? prefix.network6 : prefix.network}${mapped(host)}-${port}`;
  }
  if (connection.socketPath !== undefined) return `${prefix.socket}${socketName(connection.socketPath)}`;
  throw new TypeError(`a ${connection.adapter} connection without an address has no derived server name`);
};

export const serverKindOf = (connection: { adapter: string }, kinds: ServerKinds): ServerKind | undefined => kinds.find((kind) => kind.impliedByAdapter === connection.adapter);

const atOwnAddress = (connection: ProviderNameInput, address: { host: string; port: number }): boolean => {
  if (connection.baseUrl === undefined) return false;
  const { host, port } = networkAddressOf(connection.baseUrl);
  return host === address.host && port === String(address.port);
};

const kindName = (connection: ProviderNameInput, kind: ServerKind): string => {
  if (kind.address === undefined || atOwnAddress(connection, kind.address)) return kind.kind;
  return addressName(connection, { network: `${kind.kind}-`, network6: `${kind.kind}6-`, socket: `${kind.kind}-` });
};

const managedName = (server: string): string => MANAGED_SERVERS.find((description) => description.id === server)?.provider ?? server;

export const providerNameOf = (connection: ProviderNameInput, kinds: ServerKinds): string => {
  if (connection.provider !== undefined) return connection.provider;
  const kind = serverKindOf(connection, kinds);
  if (kind !== undefined) return kindName(connection, kind);
  if (connection.plan !== undefined) return connection.plan.account ?? connection.plan.profile;
  if (connection.server !== undefined) return managedName(connection.server);
  return addressName(connection, { network: 'srv-', network6: 'srv6-', socket: '' });
};

export const PROVIDER_NAME_RULE_TEXT = 'must start with a lower-case letter and use only lower-case letters, digits, . _ -';

export const isProviderName = (name: string): boolean => PROVIDER_NAME_PATTERN.test(name);

const adapterLabelOf = (adapter: string): string => (Object.hasOwn(SERVER_ADAPTER_LABELS, adapter) ? `the ${SERVER_ADAPTER_LABELS[adapter as keyof typeof SERVER_ADAPTER_LABELS]}` : `the ${adapter} API`);

export const reservedNameProblem = (name: string, adapter: string, kinds: ServerKinds): string | undefined => {
  const kind = kinds.find((candidate) => candidate.kind === name && candidate.kind !== GENERIC_SERVER_KIND);
  if (kind === undefined || kind.adapter === adapter) return undefined;
  return `"${name}" is the name of ${kind.label} servers, which use ${kind.adapterLabel}; this server uses ${adapterLabelOf(adapter)}. Choose another name.`;
};
