import { describe, expect, it } from 'vitest';
import { SOLVER_THREAD_POLL_MS, SOLVER_THREAD_STOP_BOUND_MS, stopSolverThreads } from '../src/engine.ts';
import type { SolverThreads } from '../src/engine.ts';

type Stub = { terminated: boolean };

const threadsThatComeBack = (returns: number): SolverThreads & { terminations: () => number; cancelled: () => number; alive: () => Stub[] } => {
  let terminations = 0;
  let cancelled = 0;
  let comebacks = returns;
  const made: Stub[] = [{ terminated: false }, { terminated: false }];
  const pthread = {
    runningWorkers: [made[0]] as Stub[],
    unusedWorkers: [made[1]] as Stub[],
    terminateAllThreads: () => {
      terminations += 1;
      for (const worker of [...pthread.runningWorkers, ...pthread.unusedWorkers]) worker.terminated = true;
      pthread.runningWorkers = [];
      pthread.unusedWorkers = [];
      if (comebacks > 0) {
        comebacks -= 1;
        setTimeout(() => {
          const late = { terminated: false };
          made.push(late);
          pthread.runningWorkers.push(late);
        }, 1);
      }
    },
  };
  return {
    PThread: pthread,
    async_cancel: () => {
      cancelled += 1;
    },
    terminations: () => terminations,
    cancelled: () => cancelled,
    alive: () => made.filter((worker) => !worker.terminated),
  };
};

describe('the solver threads are stopped within a stated bound and none is left behind', () => {
  it('terminates again a worker the solver adds after the first termination, and ends with every worker terminated', async () => {
    const threads = threadsThatComeBack(2);
    await stopSolverThreads(threads);
    expect(threads.alive()).toEqual([]);
    expect(threads.terminations()).toBe(3);
    expect(threads.cancelled()).toBe(1);
  });

  it('ends at once when no worker comes back', async () => {
    const threads = threadsThatComeBack(0);
    await stopSolverThreads(threads);
    expect(threads.terminations()).toBe(1);
    expect(threads.alive()).toEqual([]);
  });

  it('rejects, naming the bound, when workers keep coming back past it', async () => {
    const threads = threadsThatComeBack(Number.POSITIVE_INFINITY);
    await expect(stopSolverThreads(threads)).rejects.toThrow(`the solver threads did not stop within ${SOLVER_THREAD_STOP_BOUND_MS} ms`);
    expect(threads.terminations()).toBeGreaterThan(SOLVER_THREAD_STOP_BOUND_MS / SOLVER_THREAD_POLL_MS / 2);
  }, 2 * SOLVER_THREAD_STOP_BOUND_MS);
});
