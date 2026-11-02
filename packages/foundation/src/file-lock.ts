import { randomBytes } from 'node:crypto';
import { systemClock } from './clock.ts';
import type { Clock } from './clock.ts';
import { CLAIM_POLL_MS, claimWithin } from './platform/claim-within.ts';
import { hostKernelLock } from './platform/kernel-lock.ts';
import type { HeldKernelLock, KernelLockMechanism } from './platform/kernel-lock.ts';

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

export type FileLockOptions = { ports: FileLockPorts; mechanism?: KernelLockMechanism; signal?: AbortSignal; timeoutMs?: number };

const NEVER_ABORTED = new AbortController().signal;

const acquireWithinTimeout = async (lockPath: string, options: FileLockOptions): Promise<HeldKernelLock> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const signal = options.signal ?? NEVER_ABORTED;
  const outcome = await claimWithin({
    mechanism: options.mechanism ?? hostKernelLock(),
    lockPath,
    holder: String(process.pid),
    timing: { now: () => options.ports.clock.now(), sleep: (ms) => options.ports.sleep(ms) },
    pollMs: CLAIM_POLL_MS,
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
