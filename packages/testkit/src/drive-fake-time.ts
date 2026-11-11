import type { FakeTimers, PendingTimer } from './fake-timers.ts';

export const DEFAULT_DRIVE_MAX_STEPS = 1_000_000;

export type DriveFakeTimeOptions = {
  done: () => boolean;
  horizonAt: number;
  description: string;
  maxSteps?: number;
  deadlineMs?: number;
  settle?: () => Promise<void>;
  ready?: () => boolean;
  considered?: (timer: PendingTimer) => boolean;
  beforeAdvance?: (candidates: readonly PendingTimer[]) => void;
  quiet?: () => boolean;
  detail?: () => string;
};

const macrotask = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

export const driveFakeTime = async (timers: FakeTimers, options: DriveFakeTimeOptions): Promise<void> => {
  const { done, horizonAt, description } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_DRIVE_MAX_STEPS;
  const { deadlineMs } = options;
  const settle = options.settle ?? macrotask;
  const ready = options.ready ?? (() => true);
  const considered = options.considered ?? (() => true);
  const horizonMs = horizonAt - timers.monotonicMs();
  const startedAt = performance.now();
  const fail = (reason: string): Error => {
    const detail = options.detail === undefined ? '' : `; ${options.detail()}`;
    return new Error(`driveFakeTime: ${description} not met within ${horizonMs} fake ms: ${reason}; pending timers ${JSON.stringify(timers.pending())}${detail}`);
  };
  for (let step = 0; ; step += 1) {
    await settle();
    if (done()) return;
    if (deadlineMs !== undefined && performance.now() - startedAt > deadlineMs) throw fail(`the real-time deadline of ${deadlineMs} ms passed`);
    if (step + 1 >= maxSteps) throw fail(`${maxSteps} steps used`);
    if (!ready()) continue;
    const watched = timers.pending().filter(considered);
    const candidates = watched.filter((timer) => timer.dueAt <= horizonAt);
    if (candidates.length === 0) {
      if (watched.length > 0 && options.quiet?.() === true) throw fail('the next timer is due beyond the horizon');
      continue;
    }
    options.beforeAdvance?.(candidates);
    const nextDue = Math.min(...candidates.map((timer) => timer.dueAt));
    await timers.advanceAsync(Math.max(0, nextDue - timers.monotonicMs()));
  }
};
