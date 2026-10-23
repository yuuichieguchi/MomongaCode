import type { ServiceTimers } from '../service/timers.ts';

export type PeriodicOptions = {
  intervalMs: number;
  run(): void | Promise<void>;
  timers: ServiceTimers;
  report(error: unknown): void;
};

export type Periodic = { stop(): Promise<void> };

export const startPeriodic = ({ intervalMs, run, timers, report }: PeriodicOptions): Periodic => {
  let stopped = false;
  let handle: unknown;
  let inFlight: Promise<void> | undefined;

  const arm = (): void => {
    handle = timers.setTimeout(() => void tick(), intervalMs);
  };

  const tick = async (): Promise<void> => {
    handle = undefined;
    if (stopped) return;
    let release: () => void = () => undefined;
    inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await run();
    } catch (error) {
      report(error);
    } finally {
      inFlight = undefined;
      release();
    }
    if (!stopped) arm();
  };

  arm();

  return {
    stop: () => {
      stopped = true;
      if (handle !== undefined) {
        timers.clearTimeout(handle);
        handle = undefined;
      }
      return inFlight ?? Promise.resolve();
    },
  };
};
