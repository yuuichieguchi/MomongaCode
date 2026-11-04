import type { Clock } from '@momonga/foundation';
import type { AdapterTarget, Capabilities, HealthResult, ProviderAdapter } from '@momonga/protocol';
import type { UpstreamEndpoint, UpstreamLiveness } from '../shared/http-client.ts';

export type OllamaAdapterOptions = {
  resolveEndpoint: (target: AdapterTarget, signal: AbortSignal) => Promise<UpstreamEndpoint>;
  capabilities: (target: AdapterTarget) => Promise<Capabilities>;
  health?: (target: AdapterTarget) => Promise<HealthResult>;
  clock: Clock;
  liveness?: UpstreamLiveness;
};

export type OllamaAdapter = ProviderAdapter & { close(): Promise<void> };
