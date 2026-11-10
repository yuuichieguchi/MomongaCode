export type RequestTracker = {
  begin(): () => void;
  idle(): Promise<void>;
  active(): number;
};

export const createRequestTracker = (): RequestTracker => {
  let active = 0;
  let idleWaiters: Array<() => void> = [];
  return {
    begin: () => {
      active += 1;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        active -= 1;
        if (active === 0) {
          const waiters = idleWaiters;
          idleWaiters = [];
          for (const waiter of waiters) waiter();
        }
      };
    },
    active: () => active,
    idle: () => (active === 0 ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.push(resolve))),
  };
};
