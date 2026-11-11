import { ConfigError } from './config-error.ts';
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

export const connectionAddressProblem = (connection: WrittenAddress & { adapter: string; plan?: unknown }): string | undefined =>
  connection.adapter === 'managed' || connection.plan !== undefined ? undefined : addressProblem(connection);

export const upstreamEndpointOf = (target: Exclude<ResolvedModelTarget, { adapter: 'managed' }>): UpstreamEndpointKeyed => {
  const reading = addressOf(target);
  if (reading.kind === 'problem') throw new ConfigError(`${target.adapter} target: ${reading.reason}`);
  return reading;
};

export const probeRecordKeyOf = (canon: string, target: ResolvedModelTarget): ProbeRecordKey | undefined => {
  if (target.adapter === 'managed') return { kind: 'model', model: canon };
  if (target.adapter === 'ollama' || (target.adapter === 'chat-completions' && target.toolCalling === 'auto')) {
    return { kind: 'endpoint', key: { endpoint: endpointKeyOf(upstreamEndpointOf(target)), model: target.model } };
  }
  return undefined;
};
