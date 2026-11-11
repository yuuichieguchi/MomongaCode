import { DEFAULT_ANTHROPIC_BASE_URL } from '@momonga/protocol';
import { ConfigError } from './config-error.ts';
import { ADAPTERS, isAdapterKind, measuringProbeOf, probeRecordKeyIn } from './adapters.ts';
import type { ResolvedModelTarget } from './settings.ts';

export type UpstreamEndpointKeyed = { kind: 'unix'; socketPath: string } | { kind: 'tcp'; baseUrl: string };

export type EndpointProbeKey = { endpoint: string; model: string };

export type ProbeRecordKey = { kind: 'model'; model: string } | { kind: 'endpoint'; key: EndpointProbeKey };

const ONE_LOOPBACK_HOST = '127.0.0.1';
const LOOPBACK_NAMES: ReadonlySet<string> = new Set([ONE_LOOPBACK_HOST, 'localhost', '::1']);

const unbracketed = (host: string): string => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host);

export const addressHostKeyOf = (host: string): string => (LOOPBACK_NAMES.has(unbracketed(host).toLowerCase()) ? ONE_LOOPBACK_HOST : host);

const withoutTrailingSlashes = (address: string): string => address.replace(/\/+$/, '');

const networkKeyOf = (baseUrl: string): string => {
  if (!URL.canParse(baseUrl)) return withoutTrailingSlashes(baseUrl);
  const url = new URL(baseUrl);
  const host = addressHostKeyOf(url.hostname);
  if (host === url.hostname) return withoutTrailingSlashes(baseUrl);
  url.hostname = host;
  return withoutTrailingSlashes(url.href);
};

export const endpointKeyOf = (upstream: UpstreamEndpointKeyed): string => (upstream.kind === 'unix' ? `unix:${upstream.socketPath}` : networkKeyOf(upstream.baseUrl));

export type WrittenAddress = { baseUrl?: string | undefined; socketPath?: string | undefined };

type AddressReading = UpstreamEndpointKeyed | { kind: 'problem'; reason: string };

const addressOf = ({ baseUrl, socketPath }: WrittenAddress): AddressReading => {
  if (baseUrl !== undefined && socketPath !== undefined) return { kind: 'problem', reason: 'baseUrl and socketPath cannot both be written; exactly one names the server' };
  if (socketPath !== undefined) return { kind: 'unix', socketPath };
  if (baseUrl !== undefined) return { kind: 'tcp', baseUrl };
  return { kind: 'problem', reason: 'exactly one of baseUrl and socketPath is required' };
};

export const addressProblem = (address: WrittenAddress): string | undefined => {
  const reading = addressOf(address);
  return reading.kind === 'problem' ? reading.reason : undefined;
};

const DEFAULT_ADDRESS_OF_ADAPTER: Readonly<Record<string, WrittenAddress>> = { anthropic: { baseUrl: DEFAULT_ANTHROPIC_BASE_URL } };

export const withDefaultAddress = <T extends WrittenAddress & { adapter: string }>(connection: T): T => {
  if (connection.baseUrl !== undefined || connection.socketPath !== undefined || !Object.hasOwn(DEFAULT_ADDRESS_OF_ADAPTER, connection.adapter)) return connection;
  return { ...connection, ...DEFAULT_ADDRESS_OF_ADAPTER[connection.adapter] };
};

const namesItsServerByAddress = (adapter: string): boolean => !isAdapterKind(adapter) || ADAPTERS[adapter].address === 'written';

export const connectionAddressProblem = (connection: WrittenAddress & { adapter: string; plan?: unknown }): string | undefined =>
  namesItsServerByAddress(connection.adapter) && connection.plan === undefined ? addressProblem(withDefaultAddress(connection)) : undefined;

export const upstreamEndpointOf = (target: WrittenAddress & { readonly adapter: string }): UpstreamEndpointKeyed => {
  const reading = addressOf(target);
  if (reading.kind === 'problem') throw new ConfigError(`${target.adapter} target: ${reading.reason}`);
  return reading;
};

export const recordKeyOf = (canon: string, target: ResolvedModelTarget): ProbeRecordKey | undefined => probeRecordKeyIn(ADAPTERS)(canon, target);

export const probeRecordKeyOf = (canon: string, target: ResolvedModelTarget): ProbeRecordKey | undefined =>
  measuringProbeOf(target) === undefined ? undefined : recordKeyOf(canon, target);
