export type OrderedQueue = {
  enqueue(task: () => Promise<void>): void;
  deliver(task: () => Promise<void>): Promise<void>;
  settled(): Promise<void>;
};

export const createOrderedQueue = (): OrderedQueue => {
  let tail: Promise<void> = Promise.resolve();
  let failure: { readonly error: unknown } | undefined;
  return {
    enqueue: (task) => {
      tail = tail.then(async () => {
        if (failure !== undefined) return;
        try {
          await task();
        } catch (error) {
          failure = { error };
        }
      });
    },
    deliver: (task) => {
      const delivered = tail.then(async () => {
        if (failure !== undefined) throw failure.error;
        await task();
      });
      tail = delivered.catch(() => undefined);
      return delivered;
    },
    settled: async () => {
      await tail;
      if (failure !== undefined) throw failure.error;
    },
  };
};

export type TaskGroup = {
  run(task: () => Promise<void>): void;
  settled(): Promise<void>;
};

export const createTaskGroup = (onFailure: (error: unknown) => void): TaskGroup => {
  const pending = new Set<Promise<void>>();
  let failure: { readonly error: unknown } | undefined;
  return {
    run: (task) => {
      const tracked: Promise<void> = task()
        .catch((error: unknown) => {
          if (failure !== undefined) return;
          failure = { error };
          onFailure(error);
        })
        .finally(() => {
          pending.delete(tracked);
        });
      pending.add(tracked);
    },
    settled: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
      if (failure !== undefined) throw failure.error;
    },
  };
};
