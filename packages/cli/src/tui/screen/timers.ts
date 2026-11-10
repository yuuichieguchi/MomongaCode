import type { Timing } from '@momonga/foundation';

export type ScreenTimers = Pick<Timing, 'setTimeout' | 'clearTimeout'>;

export const every = (timers: ScreenTimers, ms: number, run: () => void): (() => void) => {
  let handle: unknown;
  const turn = (): void => {
    handle = timers.setTimeout(turn, ms);
    run();
  };
  handle = timers.setTimeout(turn, ms);
  return () => timers.clearTimeout(handle);
};
