import type { Clock } from '@momonga/foundation';
import type { Telemetry } from '@momonga/observability';
import type { CompactionCodec } from './compaction.ts';
import type { Router } from './router.ts';
import type { GatewayStore } from './store.ts';
import type { GatewayConfig, GatewayTimers } from '../types.ts';

export type Services = {
  config: GatewayConfig;
  clock: Clock;
  timers: GatewayTimers;
  random: () => number;
  router: Router;
  store: GatewayStore;
  codec: CompactionCodec;
  telemetry: Telemetry | undefined;
  closeSignal: AbortSignal;
  forceCloseSignal: AbortSignal;
};
