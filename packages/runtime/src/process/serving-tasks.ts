import type { Clock, GenerationRole } from '@momonga/foundation';

export const SERVING_TASK_NAMES = ['idempotency-purge', 'session-scratch', 'spawn-scratch', 'call-locks', 'fidelity-prune', 'tool-markers', 'job-reconcile', 'placeholder-recovery'] as const;

export const SERVING_LOOP_NAMES = ['approval-sweeper', 'terminal-sweeper', 'search-sweeper', 'memory-sweeper', 'facts-sweeper', 'body-purge'] as const;

export const EVERY_ROLE_LOOP_NAMES = ['role-tick', 'store-identity', 'session-state-eviction', 'data-version-poll'] as const;

export type ServingTaskName = (typeof SERVING_TASK_NAMES)[number];

export type ServingTaskOutcome = 'done' | 'again';

export type ServingTask = {
  name: ServingTaskName;
  intervalMs: number;
  lastRanAt?: number;
  run(): ServingTaskOutcome | Promise<ServingTaskOutcome>;
};

export type ServingLoop = { start(): { stop(): void | Promise<void> } };

export type ServingTasksOptions = {
  tasks: readonly ServingTask[];
  loops: readonly ServingLoop[];
  clock: Clock;
  report(error: unknown): void;
};

export type ServingTasks = { tick(role: GenerationRole): Promise<void>; close(): Promise<void> };

export const createServingTasks = ({ tasks, loops, clock, report }: ServingTasksOptions): ServingTasks => {
  const lastRanAt = new Map<ServingTaskName, number>();
  for (const task of tasks) if (task.lastRanAt !== undefined) lastRanAt.set(task.name, task.lastRanAt);
  let running: { stop(): void | Promise<void> }[] | undefined;
  let closed = false;

  const stopLoops = async (): Promise<void> => {
    const stopping = running;
    running = undefined;
    if (stopping !== undefined) await Promise.all(stopping.map((loop) => loop.stop()));
  };

  const due = (task: ServingTask): boolean => {
    const last = lastRanAt.get(task.name);
    return last === undefined || clock.now() - last >= task.intervalMs;
  };

  return {
    tick: async (role) => {
      if (closed) return;
      if (role !== 'serving') {
        await stopLoops();
        return;
      }
      running ??= loops.map((loop) => loop.start());
      for (const task of tasks) {
        if (closed) return;
        if (!due(task)) continue;
        const startedAt = clock.now();
        try {
          if ((await task.run()) === 'done') lastRanAt.set(task.name, startedAt);
        } catch (error) {
          lastRanAt.set(task.name, startedAt);
          report(error);
        }
      }
    },
    close: async () => {
      closed = true;
      await stopLoops();
    },
  };
};
