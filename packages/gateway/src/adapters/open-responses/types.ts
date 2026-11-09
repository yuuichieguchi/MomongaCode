import type { Clock } from '@momonga/foundation';
import type { AdapterTarget, Capabilities, ErrorRules, HealthResult, ProviderAdapter } from '@momonga/protocol';
import type { AdapterAuth } from '../shared/auth.ts';
import type { UserDialects } from '../../dialect/choice.ts';
import type { UpstreamEndpoint, UpstreamLiveness } from '../shared/http-client.ts';

export type OpenResponsesAdapterOptions = {
  resolveEndpoint: (target: AdapterTarget, signal: AbortSignal) => Promise<UpstreamEndpoint>;
  authSource?: AdapterAuth;
  errorRules?: ErrorRules;
  capabilities: (target: AdapterTarget) => Promise<Capabilities>;
  health?: (target: AdapterTarget) => Promise<HealthResult>;
  clock: Clock;
  liveness: UpstreamLiveness;
  userDialects?: UserDialects;
};

export type OpenResponsesAdapter = ProviderAdapter & { close(): Promise<void> };
