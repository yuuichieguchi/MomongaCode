import type { Timing } from '@momonga/foundation';
import type { FakeClock } from './fake-clock.ts';

export type SteppingTiming = Timing & { readonly sleeps: number[] };

export const createSteppingTiming = (clock: FakeClock): SteppingTiming => {
  const sleeps: number[] = [];
  const waiting = new Set<unknown>();
  return {
    sleeps,
    now: () => clock.now(),
    monotonicMs: () => clock.monotonicMs(),
    setTimeout: (callback, ms) => {
      const handle = {};
      waiting.add(handle);
      queueMicrotask(() => {
        if (!waiting.delete(handle)) return;
        sleeps.push(ms);
        clock.advance(ms);
        callback();
      });
      return handle;
    },
    clearTimeout: (handle) => {
      waiting.delete(handle);
    },
  };
};
