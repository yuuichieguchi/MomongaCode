import type { AdapterContext, ReasoningOrigin } from '@momonga/protocol';
import type { Services } from './services.ts';
import type { TargetRuntime } from './router.ts';

export const originOf = (services: Services, target: TargetRuntime): ReasoningOrigin => services.reasoningOrigin.originFor(target.adapter.kind, target.model);

export const adapterContextOf = (services: Services, target: TargetRuntime, signal: AbortSignal, attempt: number): AdapterContext => ({
  signal,
  target: { name: target.name, model: target.model },
  attempt,
  reasoningOrigin: originOf(services, target),
});
