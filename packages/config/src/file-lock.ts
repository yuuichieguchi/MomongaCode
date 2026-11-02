import { randomBytes } from 'node:crypto';
import { ProcessLockHeldError, acquireProcessLock, comparablePath, sha256Hex, systemClock } from '@momonga/foundation';
import type { Clock } from '@momonga/foundation';
import { layoutOf } from './layout.ts';

const LOCK_RETRY_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 10000;
const KEY_HEX_CHARS = 32;

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

export const settingsLockPath = (home: string, file: string): string => `${layoutOf(home).run}/settings-${sha256Hex(comparablePath(file)).slice(0, KEY_HEX_CHARS)}.lock`;

export type FileLockOptions = { ports: FileLockPorts; timeoutMs?: number };

export const withFileLock = async <T>(lockPath: string, task: () => Promise<T>, options: FileLockOptions): Promise<T> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const deadline = options.ports.clock.now() + timeoutMs;
  for (;;) {
    try {
      const lock = await acquireProcessLock(lockPath);
      try {
        return await task();
      } finally {
        lock.release();
      }
    } catch (error) {
      if (!(error instanceof ProcessLockHeldError)) throw error;
      if (options.ports.clock.now() >= deadline) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for lock ${lockPath} held by ${error.holderPid === undefined ? 'another process' : `process ${error.holderPid}`}`, { cause: error });
      }
      await options.ports.sleep(LOCK_RETRY_MS);
    }
  }
};
