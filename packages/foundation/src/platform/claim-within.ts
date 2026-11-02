import type { ReapTiming } from '../process-markers.ts';
import { writeHolderOrRelease } from './kernel-lock.ts';
import type { HeldKernelLock, KernelLockMechanism } from './kernel-lock.ts';

export const CLAIM_POLL_MS = 25;

export type ClaimWithinRequest = {
  mechanism: KernelLockMechanism;
  lockPath: string;
  holder: string;
  timing: ReapTiming;
  pollMs: number;
  waitMs: number;
  signal: AbortSignal;
};

export type ClaimWithinOutcome = { kind: 'claimed'; lock: HeldKernelLock } | { kind: 'aborted' } | { kind: 'timed_out'; holder: string | undefined };

export const claimWithin = async ({ mechanism, lockPath, holder, timing, pollMs, waitMs, signal }: ClaimWithinRequest): Promise<ClaimWithinOutcome> => {
  const deadline = timing.now() + waitMs;
  for (;;) {
    if (signal.aborted) return { kind: 'aborted' };
    const outcome = await mechanism.claim(lockPath);
    if (outcome.kind === 'claimed') {
      writeHolderOrRelease(outcome.lock, holder);
      return { kind: 'claimed', lock: outcome.lock };
    }
    if (timing.now() >= deadline) return { kind: 'timed_out', holder: await mechanism.readHolder(lockPath) };
    await timing.sleep(pollMs);
  }
};
