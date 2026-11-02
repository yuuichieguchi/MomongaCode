import fs from 'node:fs';
import path from 'node:path';
import { CLAIM_POLL_MS, claimWithin } from '@momonga/foundation';
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
    const outcome = await claimWithin({ mechanism, lockPath: path.join(dir, `${key}.lock`), holder: String(process.pid), timing, pollMs: CLAIM_POLL_MS, waitMs, signal });
    if (outcome.kind === 'aborted') return 'aborted';
    if (outcome.kind === 'claimed') return { release: () => outcome.lock.dispose() };
    throw new EarlierAttemptNotStoppedError(
      `the call ${key} is still held by ${outcome.holder === undefined || outcome.holder === '' ? 'another attempt' : `process ${outcome.holder}`} after ${waitMs} ms, so the earlier attempt could not be confirmed stopped`,
      'lock_held',
    );
  },
});
