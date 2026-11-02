import { randomBytes } from 'node:crypto';
import { systemClock } from './clock.ts';
import type { Clock } from './clock.ts';
import { ProcessLockHeldError, acquireProcessLock } from './process-lock.ts';
import type { ProcessLock } from './process-lock.ts';

export const LOCK_RETRY_MS = 10;
export const DEFAULT_LOCK_TIMEOUT_MS = 10000;

export type FileLockPorts = {
  clock: Clock;
  sleep(ms: number): Promise<void>;
  randomHex(bytes: number): string;
};

export const systemFileLockPorts: FileLockPorts = {
  clock: systemClock,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  randomHex: (bytes) => randomBytes(bytes).toString('hex'),
};

export type FileLockOptions = { ports: FileLockPorts; timeoutMs?: number };

const acquireWithinTimeout = async (lockPath: string, options: FileLockOptions): Promise<ProcessLock> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const deadline = options.ports.clock.now() + timeoutMs;
  for (;;) {
    try {
      return await acquireProcessLock(lockPath);
    } catch (error) {
      if (!(error instanceof ProcessLockHeldError)) throw error;
      if (options.ports.clock.now() >= deadline) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for lock ${lockPath} held by ${error.holderPid === undefined ? 'another process' : `process ${error.holderPid}`}`,
          { cause: error },
        );
      }
      await options.ports.sleep(LOCK_RETRY_MS);
    }
  }
};

export const withFileLock = async <T>(lockPath: string, task: () => Promise<T>, options: FileLockOptions): Promise<T> => {
  const lock = await acquireWithinTimeout(lockPath, options);
  try {
    return await task();
  } finally {
    lock.release();
  }
};

export type KeyedSerializer = <T>(key: string, task: () => Promise<T>) => Promise<T>;

export const createKeyedSerializer = (): KeyedSerializer => {
  const queues = new Map<string, Promise<void>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, settled);
    void settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });
    return run;
  };
};
