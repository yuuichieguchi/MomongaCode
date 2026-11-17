import fs from 'node:fs';
import { POLL_INTERVAL_MS, systemWaitTiming, waitUntil } from '@momonga/foundation';

export const HARNESS_WAIT_MS = 45_000;

export type WaitForOptions = { boundMs?: number; description?: string };

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const afterMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const waitFor = async (predicate: () => boolean | Promise<boolean>, options: WaitForOptions = {}): Promise<void> => {
  const boundMs = options.boundMs ?? HARNESS_WAIT_MS;
  const deadline = systemWaitTiming.monotonicMs() + boundMs;
  while (!(await predicate())) {
    if (systemWaitTiming.monotonicMs() >= deadline) throw new Error(`waitFor: condition not met within ${boundMs} ms${options.description === undefined ? '' : `: ${options.description}`}`);
    await turn();
  }
};

export type PollUntilOptions = { description: string; boundMs: number };

export const pollUntil = async (condition: () => boolean | Promise<boolean>, options: PollUntilOptions): Promise<void> => {
  const outcome = await waitUntil(systemWaitTiming, async () => ((await condition()) ? true : undefined), { intervalMs: POLL_INTERVAL_MS, deadline: systemWaitTiming.monotonicMs() + options.boundMs });
  if (outcome.kind !== 'found') throw new Error(`pollUntil: ${options.description} not met within ${options.boundMs} ms`);
};

export type FileWaitOptions = { description: string; boundMs: number; signal?: AbortSignal; holds?: (content: string) => boolean };

const readIfPresent = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

export const waitForFile = async (file: string, options: FileWaitOptions): Promise<string> => {
  const holds = options.holds ?? (() => true);
  const outcome = await waitUntil(
    systemWaitTiming,
    async () => {
      const content = readIfPresent(file);
      return content !== undefined && holds(content) ? content : undefined;
    },
    { intervalMs: POLL_INTERVAL_MS, deadline: systemWaitTiming.monotonicMs() + options.boundMs, signal: options.signal },
  );
  if (outcome.kind === 'found') return outcome.value;
  if (outcome.kind === 'aborted') throw options.signal?.reason;
  throw new Error(`waitForFile: ${options.description} not met within ${options.boundMs} ms (${file})`);
};
