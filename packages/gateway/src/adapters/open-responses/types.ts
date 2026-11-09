import type { Clock } from '@momonga/foundation';
import type { AdapterTarget, Capabilities, HealthResult, ProviderAdapter } from '@momonga/protocol';
import type { UserDialects } from '../../dialect/choice.ts';
import type { UpstreamEndpoint, UpstreamLiveness } from '../shared/http-client.ts';

export type OpenResponsesAdapterOptions = {
  resolveEndpoint: (target: AdapterTarget, signal: AbortSignal) => Promise<UpstreamEndpoint>;
  apiKey?: (target: AdapterTarget, signal: AbortSignal) => Promise<string | undefined>;
  capabilities: (target: AdapterTarget) => Promise<Capabilities>;
  health?: (target: AdapterTarget) => Promise<HealthResult>;
  clock: Clock;
  liveness: UpstreamLiveness;
  userDialects?: UserDialects;
};

export type OpenResponsesAdapter = ProviderAdapter & { close(): Promise<void> };
