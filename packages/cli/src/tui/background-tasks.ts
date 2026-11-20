type Task = { controller: AbortController; settled: Promise<void>; seq: number };

export type BackgroundTasks = {
  run<T>(work: (signal: AbortSignal) => Promise<T>, options?: { readonly signal?: AbortSignal; readonly seq?: number }): Promise<T>;
  abortNewest(): boolean;
  newestSeq(): number;
  active(): boolean;
  settle(): Promise<void>;
  count(): number;
  subscribe(listener: () => void): () => void;
};

export const createBackgroundTasks = (): BackgroundTasks => {
  const tasks: Task[] = [];
  const listeners = new Set<() => void>();

  const run = <T>(work: (signal: AbortSignal) => Promise<T>, options?: { readonly signal?: AbortSignal; readonly seq?: number }): Promise<T> => {
    const controller = new AbortController();
    const external = options?.signal;
    const forwardAbort = (): void => controller.abort(external?.reason ?? new Error('cancelled'));
    if (external !== undefined) {
      if (external.aborted) forwardAbort();
      else external.addEventListener('abort', forwardAbort, { once: true });
    }
    const running = work(controller.signal);
    const task: Task = { controller, settled: running.then(() => undefined, () => undefined), seq: options?.seq ?? 0 };
    tasks.push(task);
    void task.settled.then(() => {
      external?.removeEventListener('abort', forwardAbort);
      const index = tasks.indexOf(task);
      if (index >= 0) tasks.splice(index, 1);
      for (const listener of [...listeners]) listener();
    });
    return running;
  };

  const abortNewest = (): boolean => {
    const newest = tasks.findLast((task) => !task.controller.signal.aborted);
    if (newest === undefined) return false;
    newest.controller.abort(new Error('cancelled'));
    return true;
  };

  const newestSeq = (): number => tasks.findLast((task) => !task.controller.signal.aborted)?.seq ?? 0;

  const active = (): boolean => tasks.some((task) => !task.controller.signal.aborted);

  const settle = async (): Promise<void> => {
    for (const task of tasks) task.controller.abort(new Error('the interface is closing'));
    await Promise.all(tasks.map((task) => task.settled));
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return { run, abortNewest, newestSeq, active, settle, count: () => tasks.length, subscribe };
};
