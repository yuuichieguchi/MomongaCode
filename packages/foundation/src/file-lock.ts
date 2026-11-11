import { settledOrAborted } from './operation-limit.ts';
import { claimWithin } from './platform/claim-within.ts';
import type { HeldKernelLock, KernelLockMechanism } from './platform/kernel-lock.ts';
import type { Random } from './random.ts';
import { systemRandom } from './system-random.ts';
import { systemWaitTiming } from './system-timing.ts';
import type { Timing } from './timing.ts';

export const DEFAULT_LOCK_TIMEOUT_MS = 10000;

export type FileLockPorts = { timing: Timing; random: Random };

export const systemFileLockPorts: FileLockPorts = { timing: systemWaitTiming, random: systemRandom };

export type FileLockOptions = { ports: FileLockPorts; mechanism: KernelLockMechanism; signal?: AbortSignal; timeoutMs?: number };

const NEVER_ABORTED = new AbortController().signal;

const waitBoundOf = (options: FileLockOptions): number => {
  if (options.timeoutMs !== undefined) return options.timeoutMs;
  return options.signal === undefined ? DEFAULT_LOCK_TIMEOUT_MS : Number.POSITIVE_INFINITY;
};

const acquireWithinTimeout = async (lockPath: string, options: FileLockOptions): Promise<HeldKernelLock> => {
  const timeoutMs = waitBoundOf(options);
  const signal = options.signal ?? NEVER_ABORTED;
  const outcome = await claimWithin({
    mechanism: options.mechanism,
    lockPath,
    holder: String(process.pid),
    timing: options.ports.timing,
    waitMs: timeoutMs,
    signal,
  });
  if (outcome.kind === 'aborted') throw signal.reason;
  if (outcome.kind === 'timed_out') {
    throw new Error(`timed out after ${timeoutMs}ms waiting for lock ${lockPath} held by ${outcome.holder === undefined || outcome.holder === '' ? 'another process' : `process ${outcome.holder}`}`);
  }
  return outcome.lock;
};

export const withFileLock = async <T>(lockPath: string, task: () => Promise<T>, options: FileLockOptions): Promise<T> => {
  const lock = await acquireWithinTimeout(lockPath, options);
  try {
    return await task();
  } finally {
    lock.release();
  }
};

export type KeyedSerializer = <T>(key: string, task: () => Promise<T>, signal: AbortSignal) => Promise<T>;

const settledEitherWay = (): void => undefined;

export const createKeyedSerializer = (): KeyedSerializer => {
  const queues = new Map<string, Promise<void>>();
  return <T>(key: string, task: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = settledOrAborted(previous, signal).then(task);
    const settled = previous.then(() => run.then(settledEitherWay, settledEitherWay));
    queues.set(key, settled);
    void settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });
    return run;
  };
};
