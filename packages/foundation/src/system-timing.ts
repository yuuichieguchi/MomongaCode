import type { Clock } from './clock.ts';
import type { Timing } from './timing.ts';

const clearHostTimer = (handle: unknown): void => clearTimeout(handle as NodeJS.Timeout);

export const systemTiming: Timing = {
  now: () => Date.now(),
  monotonicMs: () => performance.now(),
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return timer;
  },
  clearTimeout: clearHostTimer,
};

export const systemWaitTiming: Timing = {
  now: systemTiming.now,
  monotonicMs: systemTiming.monotonicMs,
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: clearHostTimer,
};

export const systemClock: Clock = systemTiming;
