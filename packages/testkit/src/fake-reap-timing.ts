import { AsyncLocalStorage } from 'node:async_hooks';
import type { FakeClock } from './fake-clock.ts';
import { createFakeTimers } from './fake-timers.ts';
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

export type PacedReapTiming = { now(): number; sleep(ms: number): Promise<void>; readonly sleeps: number[]; pairedWith<T>(startRealOperation: () => Promise<T>): Promise<T> };

const eventLoopTurn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

export const pacedReapTiming = (clock: FakeClock, timers: FakeTimers = createFakeTimers(clock)): PacedReapTiming => {
  const inFlight = new Set<Promise<void>>();
  const sleeps: number[] = [];
  const insidePairedOperation = new AsyncLocalStorage<true>();
  return {
    now: () => clock.now(),
    sleeps,
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
    sleep: async (ms) => {
      if (insidePairedOperation.getStore() === true) {
        throw new Error('pacedReapTiming: an operation paired with this timing slept on it; the sleep waits for the operation and the operation for the sleep, so neither could end');
      }
      sleeps.push(ms);
      await timers.advanceAsync(ms);
      if (inFlight.size === 0) await eventLoopTurn();
      else await Promise.all([...inFlight]);
    },
  };
};

export const HOLD_UNTIL_SIGNALLED_ARGV = ['/usr/bin/tail', '-f', '/dev/null'] as const;

export const HOLD_UNTIL_SIGNALLED = HOLD_UNTIL_SIGNALLED_ARGV.join(' ');
