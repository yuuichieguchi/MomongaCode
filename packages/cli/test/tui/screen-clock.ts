import type { ScreenTimers } from '../../src/tui/screen/timers.ts';

type Pending = { at: number; run(): void };

export type ManualClock = { now(): number; timers: ScreenTimers; advance(ms: number): void; pending(): number };

export const manualClock = (start = 0): ManualClock => {
  let time = start;
  let waiting: Pending[] = [];
  const due = (limit: number): Pending | undefined => waiting.filter((timer) => timer.at <= limit).sort((left, right) => left.at - right.at)[0];
  return {
    now: () => time,
    timers: {
      setTimeout: (run, ms) => {
        const timer: Pending = { at: time + ms, run };
        waiting.push(timer);
        return timer;
      },
      clearTimeout: (handle) => {
        waiting = waiting.filter((timer) => timer !== handle);
      },
    },
    advance: (ms) => {
      const limit = time + ms;
      for (let next = due(limit); next !== undefined; next = due(limit)) {
        const timer = next;
        waiting = waiting.filter((other) => other !== timer);
        time = timer.at;
        timer.run();
      }
      time = limit;
    },
    pending: () => waiting.length,
  };
};
