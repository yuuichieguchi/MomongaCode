import type { Clock } from '@momonga/foundation';
import type { AdapterTarget, AnthropicApiVersion, Capabilities, HealthResult, ProviderAdapter } from '@momonga/protocol';
import type { UserDialects } from '../../dialect/choice.ts';
import type { AdapterAuth } from '../shared/auth.ts';
import type { UpstreamEndpoint, UpstreamLiveness } from '../shared/http-client.ts';

export type AnthropicAdapterOptions = {
  resolveEndpoint: (target: AdapterTarget, signal: AbortSignal) => Promise<UpstreamEndpoint>;
  authSource: AdapterAuth;
  capabilities: (target: AdapterTarget) => Promise<Capabilities>;
  health?: (target: AdapterTarget) => Promise<HealthResult>;
  clock: Clock;
  apiVersion: AnthropicApiVersion;
  liveness: UpstreamLiveness;
  userDialects?: UserDialects;
};

export type AnthropicAdapter = ProviderAdapter & { close(): Promise<void> };
