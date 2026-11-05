import type { Clock } from '@momonga/foundation';
import type { AdapterTarget, AnthropicApiVersion, Capabilities, HealthResult, ProviderAdapter } from '@momonga/protocol';
import type { UpstreamEndpoint, UpstreamLiveness } from '../shared/http-client.ts';

export type AnthropicAdapterOptions = {
  resolveEndpoint: (target: AdapterTarget) => Promise<UpstreamEndpoint>;
  apiKey: (target: AdapterTarget, signal: AbortSignal) => Promise<string>;
  capabilities: (target: AdapterTarget) => Promise<Capabilities>;
  health?: (target: AdapterTarget) => Promise<HealthResult>;
  clock: Clock;
  apiVersion: AnthropicApiVersion;
  liveness?: UpstreamLiveness;
};

export type AnthropicAdapter = ProviderAdapter & { close(): Promise<void> };
