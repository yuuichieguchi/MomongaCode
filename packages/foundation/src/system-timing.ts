import type { Timing } from './timing.ts';

export const systemTiming: Timing = {
  now: () => Date.now(),
  monotonicMs: () => performance.now(),
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
