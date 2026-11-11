import type { AdapterContext, Capabilities, ReasoningOrigin, UpstreamRoute } from '@momonga/protocol';
import type { Services } from './services.ts';
import { adapterTargetOf } from './router.ts';
import type { TargetRuntime } from './router.ts';

export const originOf = (services: Services, target: TargetRuntime): ReasoningOrigin => services.reasoningOrigin.originFor(target.adapter.kind, target.model);

export const adapterContextOf = (
  services: Services,
  target: TargetRuntime,
  capabilities: Capabilities,
  signal: AbortSignal,
  attempt: number,
  idempotencyKey?: string,
  route?: (route: UpstreamRoute) => void,
): AdapterContext => ({
  ...(route === undefined ? {} : { route }),
  signal,
  target: adapterTargetOf(target),
  attempt,
  reasoningOrigin: originOf(services, target),
  capabilities,
  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
});
