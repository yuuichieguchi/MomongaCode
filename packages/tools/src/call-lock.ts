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

const CALL_LOCK_SUFFIX = '.lock';

export const sweepCallLocks = async ({ dir, mechanism }: { dir: string; mechanism: KernelLockMechanism }): Promise<void> => {
  for (const name of await fs.promises.readdir(dir)) {
    if (!name.endsWith(CALL_LOCK_SUFFIX)) continue;
    const outcome = await mechanism.claim(path.join(dir, name));
    if (outcome.kind === 'claimed') outcome.lock.dispose();
  }
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
    const outcome = await claimWithin({ mechanism, lockPath: path.join(dir, `${key}${CALL_LOCK_SUFFIX}`), holder: String(process.pid), timing, pollMs: CLAIM_POLL_MS, waitMs, signal });
    if (outcome.kind === 'aborted') return 'aborted';
    if (outcome.kind === 'claimed') return { release: () => outcome.lock.dispose() };
    throw new EarlierAttemptNotStoppedError(
      `the call ${key} is still held by ${outcome.holder === undefined || outcome.holder === '' ? 'another attempt' : `process ${outcome.holder}`} after ${waitMs} ms, so the earlier attempt could not be confirmed stopped`,
      'lock_held',
    );
  },
});
