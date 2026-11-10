import type { Lease } from '@momonga/config';
import type { Clock } from '@momonga/foundation';
import type { PriceTable, Telemetry } from '@momonga/observability';
import type { CompactionCodec } from './compaction.ts';
import type { ReasoningOriginCodec } from './reasoning-origin.ts';
import type { Redactor } from './redaction.ts';
import type { Router } from './router.ts';
import type { GatewayStore } from './store.ts';
import type { PlanTargetRef } from '../plan/api.ts';
import type { GatewayLimits, GatewayTimers } from '../types.ts';

export type GatewayEpoch = {
  readonly router: Router;
  readonly priceTable: PriceTable | undefined;
  readonly telemetry: Telemetry | undefined;
  readonly planTargets: readonly PlanTargetRef[];
};

export type GatewayEpochs = {
  acquire(signal: AbortSignal): Promise<Lease<GatewayEpoch>>;
  close(): Promise<void>;
};

export type GatewayServices = {
  config: GatewayLimits;
  clock: Clock;
  timers: GatewayTimers;
  random: () => number;
  epochs: GatewayEpochs;
  store: GatewayStore;
  codec: CompactionCodec;
  reasoningOrigin: ReasoningOriginCodec;
  closeSignal: AbortSignal;
  forceCloseSignal: AbortSignal;
  redactor: Redactor;
};

export type Services = GatewayServices & GatewayEpoch;

export const pinnedServices = (services: GatewayServices, epoch: GatewayEpoch): Services => ({ ...services, router: epoch.router, priceTable: epoch.priceTable, telemetry: epoch.telemetry, planTargets: epoch.planTargets });

export const withPinnedServices = async <T>(services: GatewayServices, signal: AbortSignal, work: (pinned: Services) => Promise<T>): Promise<T> => {
  const lease = await services.epochs.acquire(signal);
  try {
    return await work(pinnedServices(services, lease.value));
  } finally {
    lease.release();
  }
};
