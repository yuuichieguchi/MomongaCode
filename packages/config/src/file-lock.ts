import { ProcessLockHeldError, acquireProcessLock, comparablePath, sha256Hex } from '@momonga/foundation';
import { layoutOf } from './layout.ts';

const LOCK_RETRY_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 10000;
const KEY_HEX_CHARS = 32;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const settingsLockPath = (home: string, file: string): string => `${layoutOf(home).run}/settings-${sha256Hex(comparablePath(file)).slice(0, KEY_HEX_CHARS)}.lock`;

export type FileLockOptions = { timeoutMs?: number };

export const withFileLock = async <T>(lockPath: string, task: () => Promise<T>, options: FileLockOptions = {}): Promise<T> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
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
      if (Date.now() >= deadline) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for lock ${lockPath} held by ${error.holderPid === undefined ? 'another process' : `process ${error.holderPid}`}`, { cause: error });
      }
      await pause(LOCK_RETRY_MS);
    }
  }
};
