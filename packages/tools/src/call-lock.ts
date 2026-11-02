import fs from 'node:fs';
import path from 'node:path';
import { REAP_POLL_INTERVAL_MS } from '@momonga/foundation';
import type { KernelLockMechanism, ReapTiming } from '@momonga/foundation';

export class EarlierAttemptNotStoppedError extends Error {
  readonly code = 'earlier_attempt_not_stopped';
  readonly reason: 'lock_held' | 'survived' | 'unverifiable';

  constructor(message: string, reason: 'lock_held' | 'survived' | 'unverifiable', options?: ErrorOptions) {
    super(message, options);
    this.name = 'EarlierAttemptNotStoppedError';
    this.reason = reason;
  }
}

export const clearCallLocks = async (dir: string): Promise<void> => {
  const names = await fs.promises.readdir(dir);
  await Promise.all(names.map((name) => fs.promises.rm(path.join(dir, name), { force: true })));
};

export type CallLock = { release(): void };

export type CallLocks = {
  acquire(key: string, signal: AbortSignal): Promise<CallLock | 'aborted'>;
};

export type CallLocksOptions = {
  dir: string;
  mechanism: KernelLockMechanism;
  timing: ReapTiming;
  waitMs: number;
};

export const createCallLocks = ({ dir, mechanism, timing, waitMs }: CallLocksOptions): CallLocks => ({
  acquire: async (key, signal) => {
    const lockPath = path.join(dir, `${key}.lock`);
    const deadline = timing.now() + waitMs;
    for (;;) {
      if (signal.aborted) return 'aborted';
      const outcome = await mechanism.claim(lockPath);
      if (outcome.kind === 'claimed') {
        const { lock } = outcome;
        try {
          lock.writeHolder(String(process.pid));
        } catch (error) {
          lock.release();
          throw error;
        }
        return {
          release: () => {
            fs.rmSync(lockPath, { force: true });
            lock.release();
          },
        };
      }
      if (timing.now() >= deadline) {
        const holder = await mechanism.readHolder(lockPath);
        throw new EarlierAttemptNotStoppedError(
          `the call ${key} is still held by ${holder === undefined || holder === '' ? 'another attempt' : `process ${holder}`} after ${waitMs} ms, so the earlier attempt could not be confirmed stopped`,
          'lock_held',
        );
      }
      await timing.sleep(REAP_POLL_INTERVAL_MS);
    }
  },
});
