import type { ScreenTimers } from './screen/timers.ts';

export const REPLAY_PAGE_EVENTS = 500;

export type ReplayQueue = {
  push(work: () => void, position?: number): void;
  drained(): Promise<void>;
};

type Waiting = { work(): void; position: number | undefined };

type Waiter = { resolve(): void; reject(error: unknown): void };

export const createReplayQueue = (timers: ScreenTimers, onPage: (position: number) => void): ReplayQueue => {
  let waiting: Waiting[] = [];
  let head = 0;
  let position = 0;
  let pumping = false;
  let failure: { error: unknown } | undefined;
  let waiters: Waiter[] = [];

  const settle = (): void => {
    pumping = false;
    waiting = [];
    head = 0;
    const settled = waiters;
    waiters = [];
    for (const waiter of settled) {
      if (failure === undefined) waiter.resolve();
      else waiter.reject(failure.error);
    }
  };

  const turn = (): void => {
    const end = Math.min(waiting.length, head + REPLAY_PAGE_EVENTS);
    try {
      for (; head < end; head += 1) {
        const item = waiting[head];
        if (item === undefined) continue;
        item.work();
        if (item.position !== undefined) position = item.position;
      }
      onPage(position);
    } catch (error) {
      failure = { error };
      settle();
      return;
    }
    if (head < waiting.length) timers.setTimeout(turn, 0);
    else settle();
  };

  return {
    push: (work, at) => {
      if (failure !== undefined) return;
      waiting.push({ work, position: at });
      if (pumping) return;
      pumping = true;
      timers.setTimeout(turn, 0);
    },
    drained: () => {
      if (failure !== undefined) return Promise.reject(failure.error);
      if (!pumping) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
  };
};
