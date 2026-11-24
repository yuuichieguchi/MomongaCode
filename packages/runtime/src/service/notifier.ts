export type TouchedScope = { runId?: string; sessionId: string };

export type Unsubscribe = () => void;

export type RunNotifier = {
  onCommit(touched: readonly TouchedScope[]): void;
  watchRun(runId: string, wake: () => void): Unsubscribe;
  watchSession(sessionId: string, wake: () => void): Unsubscribe;
  subscribe(listener: () => void): Unsubscribe;
  wakeAll(): void;
  subscriberCount(): number;
  watchedSessionIds(): string[];
};

type Registry = Map<string, Set<() => void>>;

const addTo = (registry: Registry, key: string, wake: () => void): Unsubscribe => {
  const entry = registry.get(key) ?? new Set<() => void>();
  entry.add(wake);
  registry.set(key, entry);
  return () => {
    entry.delete(wake);
    if (entry.size === 0 && registry.get(key) === entry) registry.delete(key);
  };
};

const membersOf = (registry: Registry): Set<() => void> => {
  const members = new Set<() => void>();
  for (const entry of registry.values()) for (const wake of entry) members.add(wake);
  return members;
};

const fire = (wakes: Iterable<() => void>): void => {
  for (const wake of [...wakes]) wake();
};

export const createRunNotifier = (): RunNotifier => {
  const byRun: Registry = new Map();
  const bySession: Registry = new Map();
  const listeners = new Set<() => void>();
  let watching = 0;

  const counted = (unsubscribe: Unsubscribe): Unsubscribe => {
    watching += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      watching -= 1;
      unsubscribe();
    };
  };

  return {
    onCommit: (touched) => {
      const woken = new Set<() => void>();
      for (const scope of touched) {
        if (scope.runId !== undefined) for (const wake of byRun.get(scope.runId) ?? []) woken.add(wake);
        for (const wake of bySession.get(scope.sessionId) ?? []) woken.add(wake);
      }
      fire(woken);
      fire(listeners);
    },
    watchRun: (runId, wake) => counted(addTo(byRun, runId, wake)),
    watchSession: (sessionId, wake) => counted(addTo(bySession, sessionId, wake)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    wakeAll: () => {
      fire(membersOf(byRun));
      fire(membersOf(bySession));
      fire(listeners);
    },
    subscriberCount: () => watching,
    watchedSessionIds: () => [...bySession.keys()],
  };
};
