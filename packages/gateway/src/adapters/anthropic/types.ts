import type { Clock } from '@momonga/foundation';
import type { AdapterTarget, Capabilities, HealthResult, ProviderAdapter } from '@momonga/protocol';
import type { UpstreamEndpoint } from '../shared/http-client.ts';

export type AnthropicAdapterOptions = {
  resolveEndpoint: (target: AdapterTarget) => Promise<UpstreamEndpoint>;
  apiKey: (target: AdapterTarget, signal: AbortSignal) => Promise<string>;
  capabilities: (target: AdapterTarget) => Promise<Capabilities>;
  health?: (target: AdapterTarget) => Promise<HealthResult>;
  clock: Clock;
};

export type AnthropicAdapter = ProviderAdapter & { close(): Promise<void> };
