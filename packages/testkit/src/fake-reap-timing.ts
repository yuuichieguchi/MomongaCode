import type { Timing } from '@momonga/foundation';
import type { FakeClock } from './fake-clock.ts';
import type { FakeTimers } from './fake-timers.ts';

export type SleepSource = { now(): number; sleep(ms: number): Promise<unknown> };

export const sleepDrivenTiming = (source: SleepSource): Timing => {
  const waiting = new Set<object>();
  return {
    now: () => source.now(),
    monotonicMs: () => source.now(),
    setTimeout: (callback, ms) => {
      const handle = {};
      waiting.add(handle);
      void source.sleep(ms).then(() => {
        if (waiting.delete(handle)) callback();
      });
      return handle;
    },
    clearTimeout: (handle) => {
      waiting.delete(handle as object);
    },
  };
};

export const fakeReapTiming = (clock: FakeClock, timers: FakeTimers): Timing =>
  sleepDrivenTiming({
    now: () => clock.now(),
    sleep: (ms) => {
      timers.advance(ms);
      return Promise.resolve();
    },
  });

export const drivenReapTiming = (_clock: FakeClock, timers: FakeTimers): Timing => timers;

export type PacedReapTiming = Timing & { pairedWith<T>(realOperation: Promise<T>): Promise<T> };

export const pacedReapTiming = (clock: FakeClock): PacedReapTiming => {
  const inFlight = new Set<Promise<void>>();
  return {
    ...sleepDrivenTiming({
      now: () => clock.now(),
      sleep: async (ms) => {
        clock.advance(ms);
        if (inFlight.size === 0) await new Promise<void>((resolve) => setImmediate(resolve));
        else await Promise.all([...inFlight]);
      },
    }),
    pairedWith: (realOperation) => {
      const settled: Promise<void> = realOperation.then(
        () => undefined,
        () => undefined,
      );
      inFlight.add(settled);
      void settled.then(() => inFlight.delete(settled));
      return realOperation;
    },
  };
};

export const HOLD_UNTIL_SIGNALLED_ARGV = ['/usr/bin/tail', '-f', '/dev/null'] as const;

export const HOLD_UNTIL_SIGNALLED = HOLD_UNTIL_SIGNALLED_ARGV.join(' ');
