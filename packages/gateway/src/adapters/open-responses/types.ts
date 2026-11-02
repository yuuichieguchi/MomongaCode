import type { Clock } from '@momonga/foundation';
import type { AdapterTarget, Capabilities, HealthResult, ProviderAdapter } from '@momonga/protocol';
import type { UpstreamEndpoint } from '../shared/http-client.ts';

export type OpenResponsesAdapterOptions = {
  resolveEndpoint: (target: AdapterTarget) => Promise<UpstreamEndpoint>;
  apiKey?: (target: AdapterTarget, signal: AbortSignal) => Promise<string | undefined>;
  capabilities: (target: AdapterTarget) => Promise<Capabilities>;
  health?: (target: AdapterTarget) => Promise<HealthResult>;
  clock: Clock;
};

export type OpenResponsesAdapter = ProviderAdapter & { close(): Promise<void> };
