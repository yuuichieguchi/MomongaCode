import type { Timing } from '../timing.ts';
import { POLL_INTERVAL_MS, waitUntil } from '../wait-until.ts';
import { writeHolderOrRelease } from './kernel-lock.ts';
import type { HeldKernelLock, KernelLockMechanism } from './kernel-lock.ts';

export type ClaimWithinRequest = {
  mechanism: KernelLockMechanism;
  lockPath: string;
  holder: string;
  timing: Timing;
  waitMs: number;
  signal: AbortSignal;
};

export type ClaimWithinOutcome = { kind: 'claimed'; lock: HeldKernelLock } | { kind: 'aborted' } | { kind: 'timed_out'; holder: string | undefined };

const claimOnce = async (mechanism: KernelLockMechanism, lockPath: string): Promise<HeldKernelLock | undefined> => {
  const outcome = await mechanism.claim(lockPath);
  return outcome.kind === 'claimed' ? outcome.lock : undefined;
};

export const claimWithin = async ({ mechanism, lockPath, holder, timing, waitMs, signal }: ClaimWithinRequest): Promise<ClaimWithinOutcome> => {
  if (signal.aborted) return { kind: 'aborted' };
  const waited = await waitUntil(timing, () => claimOnce(mechanism, lockPath), { intervalMs: POLL_INTERVAL_MS, deadline: timing.monotonicMs() + waitMs, signal });
  if (waited.kind === 'aborted') return waited;
  if (waited.kind === 'timed_out') return { kind: 'timed_out', holder: await mechanism.readHolder(lockPath) };
  writeHolderOrRelease(waited.value, holder);
  return { kind: 'claimed', lock: waited.value };
};
