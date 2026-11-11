import type { FakeClock } from './fake-clock.ts';
import type { FakeTimers } from './fake-timers.ts';

export const fakeReapTiming = (clock: FakeClock, timers: FakeTimers): { now(): number; sleep(ms: number): Promise<void> } => ({
  now: () => clock.now(),
  sleep: (ms) => timers.advanceAsync(ms),
});

export const drivenReapTiming = (clock: FakeClock, timers: FakeTimers): { now(): number; sleep(ms: number): Promise<void> } => ({
  now: () => clock.now(),
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      timers.setTimeout(resolve, ms);
    }),
});

export type PacedReapTiming = { now(): number; sleep(ms: number): Promise<void>; pairedWith<T>(realOperation: Promise<T>): Promise<T> };

export const pacedReapTiming = (clock: FakeClock): PacedReapTiming => {
  const inFlight = new Set<Promise<void>>();
  return {
    now: () => clock.now(),
    pairedWith: (realOperation) => {
      const settled: Promise<void> = realOperation.then(
        () => undefined,
        () => undefined,
      );
      inFlight.add(settled);
      void settled.then(() => inFlight.delete(settled));
      return realOperation;
    },
    sleep: async (ms) => {
      clock.advance(ms);
      if (inFlight.size === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      else await Promise.all([...inFlight]);
    },
  };
};

export const HOLD_UNTIL_SIGNALLED_ARGV = ['/usr/bin/tail', '-f', '/dev/null'] as const;

export const HOLD_UNTIL_SIGNALLED = HOLD_UNTIL_SIGNALLED_ARGV.join(' ');
