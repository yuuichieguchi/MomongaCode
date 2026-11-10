import type { ScreenTimers } from '../../src/tui/screen/timers.ts';
import type { ManualClock } from './screen-clock.ts';

export type TurnTimers = { timers: ScreenTimers; turn(): void; waiting(): number };

export const turnTimers = (clock: ManualClock): TurnTimers => {
  const turns: (() => void)[] = [];
  return {
    timers: {
      setTimeout: (run, ms) => {
        if (ms !== 0) return clock.timers.setTimeout(run, ms);
        turns.push(run);
        return run;
      },
      clearTimeout: (handle) => clock.timers.clearTimeout(handle),
    },
    turn: () => {
      turns.shift()?.();
    },
    waiting: () => turns.length,
  };
};
