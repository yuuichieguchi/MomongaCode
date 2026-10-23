import type { Clock, ReapTiming } from '@momonga/foundation';
import type { ServiceTimers } from '../service/timers.ts';

export const reapTimingOf = (clock: Clock, timers: ServiceTimers): ReapTiming => ({
  now: () => clock.now(),
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      timers.setTimeout(resolve, ms);
    }),
});
