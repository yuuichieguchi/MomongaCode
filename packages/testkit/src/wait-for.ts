import { POLL_INTERVAL_MS, systemWaitTiming, waitUntil } from '@momonga/foundation';

export type WaitForOptions = { maxTurns?: number; description?: string };

const DEFAULT_MAX_TURNS = 200_000;

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const afterMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const waitFor = async (predicate: () => boolean | Promise<boolean>, options: WaitForOptions = {}): Promise<void> => {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  for (let count = 0; count < maxTurns; count += 1) {
    if (await predicate()) return;
    await turn();
  }
  if (await predicate()) return;
  throw new Error(`waitFor: condition not met after ${maxTurns} event-loop turns${options.description === undefined ? '' : `: ${options.description}`}`);
};

export type PollUntilOptions = { description: string; boundMs: number };

export const pollUntil = async (condition: () => boolean | Promise<boolean>, options: PollUntilOptions): Promise<void> => {
  const outcome = await waitUntil(systemWaitTiming, async () => ((await condition()) ? true : undefined), { intervalMs: POLL_INTERVAL_MS, deadline: systemWaitTiming.monotonicMs() + options.boundMs });
  if (outcome.kind !== 'found') throw new Error(`pollUntil: ${options.description} not met within ${options.boundMs} ms`);
};
