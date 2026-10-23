import type { Clock, JsonLogger } from '@momonga/foundation';
import type { ServiceTimers } from '../service/timers.ts';
import { asError } from './as-error.ts';

export type TeardownStep = { name: string; run(): void | Promise<void> };

export type RunTeardownOptions = {
  steps: readonly TeardownStep[];
  budgetMs: number;
  clock: Clock;
  timers: ServiceTimers;
  logger: JsonLogger;
  failureEvent?: string;
};

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';

export const runTeardown = async ({ steps, budgetMs, clock, timers, logger, failureEvent = 'teardown.step_failed' }: RunTeardownOptions): Promise<string[]> => {
  const startedAt = clock.now();
  const abandoned: string[] = [];
  for (const step of steps) {
    logger.debug('teardown.step', { step: step.name });
    let pending: void | Promise<void>;
    try {
      pending = step.run();
    } catch (error) {
      logger.error(failureEvent, { step: step.name, err: asError(error) });
      continue;
    }
    if (!isPromiseLike(pending)) continue;
    const settled = Promise.resolve(pending).then(
      () => 'settled' as const,
      (error: unknown) => {
        logger.error(failureEvent, { step: step.name, err: asError(error) });
        return 'settled' as const;
      },
    );
    const remainingMs = Math.max(0, budgetMs - (clock.now() - startedAt));
    let handle: unknown;
    const expired = new Promise<'expired'>((resolve) => {
      handle = timers.setTimeout(() => resolve('expired'), remainingMs);
    });
    try {
      if ((await Promise.race([settled, expired])) === 'expired') {
        logger.warn('teardown.abandoned', { step: step.name });
        abandoned.push(step.name);
      }
    } finally {
      timers.clearTimeout(handle);
    }
  }
  return abandoned;
};
