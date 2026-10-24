import { ENTRY_HARD_EXIT_MARGIN_MS, GATEWAY_MAX_CLOSE_MS, runtimeMaxCloseMs, supervisorMaxCloseMs } from '@momonga/foundation';
import { LOCK_POLL_MS, ORPHAN_REAP_GRACE_MS, SETTINGS_DEBOUNCE_MS, SETTINGS_POLL_MS, SHUTDOWN_RELEASE_BOUND_MS } from '@momonga/supervisor';
import { CANCEL_UPSTREAM_SETTLE_MS, GATEWAY_CANCEL_TIMEOUT_MS, SANDBOX_KILL_GRACE_MS } from '../../packages/runtime/src/process/constants.ts';

export const E2E_MARGIN_MS = 4000;
export const E2E_LEASE_MS = 3000;
export const E2E_DRAIN_TIMEOUT_MS = 1000;
export const E2E_READY_DEADLINE_MS = 30_000;
export const E2E_TEST_TIMEOUT_MS = 90_000;
export const E2E_HOOK_TIMEOUT_MS = 30_000;
export const E2E_DISPOSE_BOUND_MS = 25_000;
export const E2E_CHILD_READY_BOUND_MS = 5000;
export const E2E_RESTART_BACKOFF_MS = 200;
export const E2E_RESTART_BOUND_MS = E2E_RESTART_BACKOFF_MS + E2E_CHILD_READY_BOUND_MS;
export const E2E_RECOVERY_BOUND_MS = E2E_RESTART_BOUND_MS + E2E_LEASE_MS + E2E_MARGIN_MS;
export const E2E_SETTINGS_SEEN_BOUND_MS = SETTINGS_DEBOUNCE_MS + SETTINGS_POLL_MS + E2E_MARGIN_MS;
export const E2E_SETTINGS_RESTART_BOUND_MS = SETTINGS_DEBOUNCE_MS + SETTINGS_POLL_MS + 2 * E2E_RESTART_BOUND_MS;
export const E2E_HELD_RETRY_MS = 3000;
export const E2E_ORPHAN_CLOSE_BOUND_MS = Math.max(runtimeMaxCloseMs(E2E_DRAIN_TIMEOUT_MS), GATEWAY_MAX_CLOSE_MS) + E2E_MARGIN_MS;
export const E2E_SUPERVISOR_CLOSE_BOUND_MS = supervisorMaxCloseMs(E2E_DRAIN_TIMEOUT_MS) + ENTRY_HARD_EXIT_MARGIN_MS + E2E_MARGIN_MS;
export const E2E_REAP_CLOSE_BOUND_MS = SHUTDOWN_RELEASE_BOUND_MS + E2E_MARGIN_MS;
export const E2E_CANCEL_TERM_BOUND_MS = E2E_MARGIN_MS;
export const E2E_CANCEL_KILL_BOUND_MS = SANDBOX_KILL_GRACE_MS + E2E_MARGIN_MS;
export const E2E_CANCEL_STREAM_BOUND_MS = GATEWAY_CANCEL_TIMEOUT_MS + CANCEL_UPSTREAM_SETTLE_MS + E2E_MARGIN_MS;
export const E2E_RESTART_POLICY = { baseMs: E2E_RESTART_BACKOFF_MS, maxMs: E2E_RESTART_BACKOFF_MS, minMs: E2E_RESTART_BACKOFF_MS } as const;
export const E2E_ORPHAN_GRACE_MS = 3000;
export const E2E_REAP_TO_RUNNING_BOUND_MS = E2E_ORPHAN_GRACE_MS + ORPHAN_REAP_GRACE_MS + E2E_RESTART_BOUND_MS + E2E_MARGIN_MS;
export const E2E_PHASE2_REACHED_BOUND_MS = E2E_ORPHAN_GRACE_MS + E2E_MARGIN_MS;
export const E2E_LOCK_FREE_BOUND_MS = LOCK_POLL_MS + E2E_RESTART_BOUND_MS;
export const E2E_RUN_COMPLETED_BOUND_MS = E2E_RECOVERY_BOUND_MS + E2E_MARGIN_MS;
export const UNTIL_DEFAULT_INTERVAL_MS = 20;

export type Truthy<T> = Exclude<T, false | null | undefined | 0 | ''>;

export type UntilOptions = { deadlineMs: number; intervalMs?: number; description: string; signal?: AbortSignal };

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const describeFailure = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const withinBound = <T>(promise: Promise<T>, boundMs: number, describe: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${describe} did not happen within ${boundMs} ms`)), boundMs);
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
};

export const until = async <T>(predicate: () => T | Promise<T>, options: UntilOptions): Promise<Truthy<T>> => {
  const { deadlineMs, intervalMs = UNTIL_DEFAULT_INTERVAL_MS, description, signal } = options;
  const deadline = Date.now() + deadlineMs;
  let lastFailure: { error: unknown } | undefined;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const value = await predicate();
      if (value) return value as Truthy<T>;
    } catch (error) {
      lastFailure = { error };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const suffix = lastFailure === undefined ? '' : `; last error: ${describeFailure(lastFailure.error)}`;
      throw new Error(`timed out after ${deadlineMs} ms waiting for ${description}${suffix}`, lastFailure === undefined ? undefined : { cause: lastFailure.error });
    }
    await pause(Math.min(intervalMs, remaining));
  }
};
