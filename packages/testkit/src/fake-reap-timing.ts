import type { FakeClock } from './fake-clock.ts';
import type { FakeTimers } from './fake-timers.ts';

export const fakeReapTiming = (clock: FakeClock, timers: FakeTimers): { now(): number; sleep(ms: number): Promise<void> } => ({
  now: () => clock.now(),
  sleep: (ms) => {
    timers.advance(ms);
    return Promise.resolve();
  },
});

export const drivenReapTiming = (clock: FakeClock, timers: FakeTimers): { now(): number; sleep(ms: number): Promise<void> } => ({
  now: () => clock.now(),
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      timers.setTimeout(resolve, ms);
    }),
});
