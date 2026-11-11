import { AsyncLocalStorage } from 'node:async_hooks';
import type { Timing } from '@momonga/foundation';
import type { FakeClock } from './fake-clock.ts';
import { createFakeTimers } from './fake-timers.ts';
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
    sleep: (ms) => timers.advanceAsync(ms),
  });

export const drivenReapTiming = (_clock: FakeClock, timers: FakeTimers): Timing => timers;

export type PacedReapTiming = Timing & { readonly sleeps: number[]; pairedWith<T>(startRealOperation: () => Promise<T>): Promise<T> };

const eventLoopTurn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

export const pacedReapTiming = (clock: FakeClock, timers: FakeTimers = createFakeTimers(clock)): PacedReapTiming => {
  const inFlight = new Set<Promise<void>>();
  const sleeps: number[] = [];
  const insidePairedOperation = new AsyncLocalStorage<true>();
  const paced = sleepDrivenTiming({
    now: () => clock.now(),
    sleep: async (ms) => {
      await timers.advanceAsync(ms);
      if (inFlight.size === 0) await eventLoopTurn();
      else await Promise.all([...inFlight]);
    },
  });
  return {
    ...paced,
    sleeps,
    setTimeout: (callback, ms) => {
      if (insidePairedOperation.getStore() === true) {
        throw new Error('pacedReapTiming: an operation paired with this timing slept on it; the sleep waits for the operation and the operation for the sleep, so neither could end');
      }
      sleeps.push(ms);
      return paced.setTimeout(callback, ms);
    },
    pairedWith: (startRealOperation) => {
      const realOperation = insidePairedOperation.run(true, async () => startRealOperation());
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
