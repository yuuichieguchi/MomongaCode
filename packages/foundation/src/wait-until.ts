import { sleep } from './timing.ts';
import type { Timing } from './timing.ts';

export const POLL_INTERVAL_MS = 25;

export type WaitOutcome<T> = { kind: 'found'; value: T } | { kind: 'timed_out' } | { kind: 'aborted' };

export type WaitUntilOptions = { intervalMs: number; deadline: number; signal?: AbortSignal | undefined };

export const waitUntil = async <T>(timing: Timing, probe: () => Promise<T | undefined>, options: WaitUntilOptions): Promise<WaitOutcome<T>> => {
  const { intervalMs, deadline, signal } = options;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return { kind: 'found', value };
    if (signal?.aborted === true) return { kind: 'aborted' };
    const remaining = deadline - timing.monotonicMs();
    if (remaining <= 0) return { kind: 'timed_out' };
    if ((await sleep(timing, Math.min(intervalMs, remaining), signal)) === 'aborted') return { kind: 'aborted' };
  }
};
