import type { Clock, Timing } from '@momonga/foundation';
import type { ServiceTimers } from '../service/timers.ts';

export const reapTimingOf = (clock: Clock, timers: ServiceTimers): Timing => ({
  now: () => clock.now(),
  monotonicMs: () => clock.now(),
  setTimeout: (callback, ms) => timers.setTimeout(callback, ms),
  clearTimeout: (handle) => timers.clearTimeout(handle),
});
