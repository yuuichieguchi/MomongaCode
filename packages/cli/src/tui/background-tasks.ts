type Task = { controller: AbortController; settled: Promise<void> };

export type BackgroundTasks = {
  run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  abortNewest(): boolean;
  settle(): Promise<void>;
  count(): number;
  subscribe(listener: () => void): () => void;
};

export const createBackgroundTasks = (): BackgroundTasks => {
  const tasks: Task[] = [];
  const listeners = new Set<() => void>();

  const run = <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    const running = work(controller.signal);
    const task: Task = { controller, settled: running.then(() => undefined, () => undefined) };
    tasks.push(task);
    void task.settled.then(() => {
      tasks.splice(tasks.indexOf(task), 1);
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

  return { run, abortNewest, settle, count: () => tasks.length, subscribe };
};
