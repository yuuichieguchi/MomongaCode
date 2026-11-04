import type { ResolvedModelTarget } from './settings.ts';

export type UpstreamEndpointKeyed = { kind: 'unix'; socketPath: string } | { kind: 'tcp'; baseUrl: string };

export type EndpointProbeKey = { endpoint: string; model: string };

export type ProbeRecordKey = { kind: 'target'; target: string } | { kind: 'endpoint'; key: EndpointProbeKey };

export const endpointKeyOf = (upstream: UpstreamEndpointKeyed): string =>
  upstream.kind === 'unix' ? `unix:${upstream.socketPath}` : upstream.baseUrl.replace(/\/+$/, '');

export const upstreamEndpointOf = (target: Exclude<ResolvedModelTarget, { adapter: 'fm' }>): UpstreamEndpointKeyed => {
  if (target.socketPath !== undefined) return { kind: 'unix', socketPath: target.socketPath };
  if (target.baseUrl !== undefined) return { kind: 'tcp', baseUrl: target.baseUrl };
  throw new Error(`${target.adapter} target has neither socketPath nor baseUrl`);
};

export const probeRecordKeyOf = (name: string, target: ResolvedModelTarget): ProbeRecordKey | undefined => {
  if (target.adapter === 'fm') return { kind: 'target', target: name };
  if (target.adapter === 'ollama' || (target.adapter === 'chat-completions' && target.toolCalling === 'auto')) {
    return { kind: 'endpoint', key: { endpoint: endpointKeyOf(upstreamEndpointOf(target)), model: target.model } };
  }
  return undefined;
};
