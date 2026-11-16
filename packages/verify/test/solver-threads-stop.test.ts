import { describe, expect, it } from 'vitest';
import { SOLVER_THREAD_STOP_BOUND_MS } from '@momonga/foundation';
import { createFakeClock, createFakeTimers } from '@momonga/testkit';
import type { FakeTimers } from '@momonga/testkit';
import { SOLVER_THREAD_POLL_MS, stopSolverThreads } from '../src/engine.ts';
import type { SolverThreads } from '../src/engine.ts';

type Stub = { terminated: boolean };

const threadsThatComeBack = (timers: FakeTimers, returns: number): SolverThreads & { terminations: () => number; cancelled: () => number; alive: () => Stub[] } => {
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
        timers.setTimeout(() => {
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

const stopping = (timers: FakeTimers, threads: SolverThreads): { outcome: () => 'pending' | 'stopped' | Error; done: Promise<void> } => {
  let outcome: 'pending' | 'stopped' | Error = 'pending';
  const done = stopSolverThreads(threads, timers).then(
    () => {
      outcome = 'stopped';
    },
    (error: unknown) => {
      outcome = error instanceof Error ? error : new Error(String(error));
    },
  );
  return { outcome: () => outcome, done };
};

describe('the solver threads are stopped within a stated bound and none is left behind', () => {
  it('terminates again a worker the solver adds after the first termination, and ends with every worker terminated', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    const threads = threadsThatComeBack(timers, 2);
    const stop = stopping(timers, threads);
    await timers.advanceAsync(3 * SOLVER_THREAD_POLL_MS);
    await stop.done;
    expect(stop.outcome()).toBe('stopped');
    expect(threads.alive()).toEqual([]);
    expect(threads.terminations()).toBe(3);
    expect(threads.cancelled()).toBe(1);
  });

  it('ends at the first poll when no worker comes back', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    const threads = threadsThatComeBack(timers, 0);
    const stop = stopping(timers, threads);
    await timers.advanceAsync(SOLVER_THREAD_POLL_MS);
    await stop.done;
    expect(stop.outcome()).toBe('stopped');
    expect(threads.terminations()).toBe(1);
    expect(threads.alive()).toEqual([]);
  });

  it('rejects, naming the bound, when workers keep coming back past it, and not before', async () => {
    const timers = createFakeTimers(createFakeClock(0));
    const threads = threadsThatComeBack(timers, Number.POSITIVE_INFINITY);
    const stop = stopping(timers, threads);
    await timers.advanceAsync(SOLVER_THREAD_STOP_BOUND_MS - SOLVER_THREAD_POLL_MS);
    expect(stop.outcome()).toBe('pending');
    await timers.advanceAsync(SOLVER_THREAD_POLL_MS);
    await stop.done;
    expect(String(stop.outcome())).toContain(`the solver threads did not stop within ${SOLVER_THREAD_STOP_BOUND_MS} ms`);
  });
});
