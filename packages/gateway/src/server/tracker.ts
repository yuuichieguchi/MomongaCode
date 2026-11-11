import type { SharedWorkHold, WorkRegistry } from '../core/run.ts';

export type RequestTracker = WorkRegistry & {
  begin(): () => void;
  idle(): Promise<void>;
  active(): number;
};

type Work = { subscribers: number };

export const createRequestTracker = (): RequestTracker => {
  let requests = 0;
  const works = new Set<Work>();
  let idleWaiters: Array<() => void> = [];
  const holdsNothing = (): boolean => requests === 0 && works.size === 0;
  const settle = (): void => {
    if (!holdsNothing()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const waiter of waiters) waiter();
  };
  const detachedWorks = (): number => [...works].filter((work) => work.subscribers === 0).length;
  return {
    begin: () => {
      requests += 1;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        requests -= 1;
        settle();
      };
    },
    beginWork: (): SharedWorkHold => {
      const work: Work = { subscribers: 0 };
      works.add(work);
      return {
        subscribers: (count) => {
          work.subscribers = count;
        },
        end: () => {
          works.delete(work);
          settle();
        },
      };
    },
    active: () => requests + detachedWorks(),
    idle: () => (holdsNothing() ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.push(resolve))),
  };
};
