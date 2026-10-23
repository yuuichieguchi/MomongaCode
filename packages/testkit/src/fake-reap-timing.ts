import type { FakeClock } from './fake-clock.ts';
import type { FakeTimers } from './fake-timers.ts';

export const fakeReapTiming = (clock: FakeClock, timers: FakeTimers): { now(): number; sleep(ms: number): Promise<void> } => ({
  now: () => clock.now(),
  sleep: (ms) => {
    timers.advance(ms);
    return Promise.resolve();
  },
});
