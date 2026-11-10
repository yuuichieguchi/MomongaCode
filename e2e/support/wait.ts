import { DEFAULT_STOP_VALUES, ENTRY_HARD_EXIT_MARGIN_MS, gatewayMaxCloseMs, runtimeMaxCloseMs, supervisorMaxCloseMs } from '@momonga/foundation';
import {
  LOCK_WATCH_INTERVAL_MS,
  SETTINGS_DEBOUNCE_MS,
  SETTINGS_POLL_MS,
  SHUTDOWN_RELEASE_BOUND_MS,
  STARTUP_TIMEOUT_MS,
  STDIO_FLUSH_MS,
  childRestartBoundMs,
  orphanPhaseOneBoundMs,
  resolveRestartPolicy,
  resolveStartTiming,
  supervisorStartBoundMs,
} from '@momonga/supervisor';
import { VERIFY_BUDGET_MS } from '../../packages/cli/src/commands/policy.ts';
import { daemonReadyBoundMs } from '../../packages/cli/src/daemon/ensure-daemon.ts';
import { REFLECTION_PICKUP_BOUND_MS, reflectionAttemptsBoundMs } from '../../packages/runtime/src/memory/reflection-bound.ts';
import { RUNTIME_DEFAULTS } from '../../packages/runtime/src/process/defaults.ts';
import { SWEEP_INTERVAL_MS } from '../../packages/runtime/src/service/service.ts';
import { CANCEL_UPSTREAM_SETTLE_MS, GATEWAY_CANCEL_TIMEOUT_MS, SANDBOX_KILL_GRACE_MS } from '../../packages/runtime/src/process/constants.ts';

export const E2E_REFLECTION_ATTEMPTS_BOUND_MS = reflectionAttemptsBoundMs(RUNTIME_DEFAULTS.runTimeoutMs);
export const E2E_REFLECTION_SETTLED_BOUND_MS = REFLECTION_PICKUP_BOUND_MS + E2E_REFLECTION_ATTEMPTS_BOUND_MS;
export const E2E_MARGIN_MS = 4000;
export const E2E_LEASE_MS = 3000;
export const E2E_DRAIN_TIMEOUT_MS = 1000;
export const e2eStartBoundMs = (deps: Parameters<typeof resolveStartTiming>[0]): number => supervisorStartBoundMs(resolveStartTiming(deps));
export const E2E_READY_DEADLINE_MS = e2eStartBoundMs({ runtime: { drainTimeoutMs: E2E_DRAIN_TIMEOUT_MS } });
export const E2E_HOOK_TIMEOUT_MS = 30_000;
export const DEFAULT_TEST_TIMEOUT_MS = 60_000;
export const E2E_DISPOSE_BOUND_MS = 25_000;
export const E2E_RESTART_BACKOFF_MS = 200;
export const E2E_RESTART_POLICY = { baseMs: E2E_RESTART_BACKOFF_MS, maxMs: E2E_RESTART_BACKOFF_MS, minMs: E2E_RESTART_BACKOFF_MS } as const;
export const E2E_RESTART_BOUND_MS = childRestartBoundMs({ policy: resolveRestartPolicy(E2E_RESTART_POLICY), startupTimeoutMs: STARTUP_TIMEOUT_MS, stdioFlushMs: STDIO_FLUSH_MS });
export const E2E_RECOVERY_BOUND_MS = E2E_RESTART_BOUND_MS + E2E_LEASE_MS + E2E_MARGIN_MS;
export const E2E_SETTINGS_SEEN_BOUND_MS = SETTINGS_DEBOUNCE_MS + SETTINGS_POLL_MS + E2E_MARGIN_MS;
export const E2E_SETTINGS_RESTART_BOUND_MS = SETTINGS_DEBOUNCE_MS + SETTINGS_POLL_MS + 2 * E2E_RESTART_BOUND_MS;
export const E2E_HELD_RETRY_MS = 3000;
export const E2E_ORPHAN_CLOSE_BOUND_MS = Math.max(runtimeMaxCloseMs(E2E_DRAIN_TIMEOUT_MS), gatewayMaxCloseMs(DEFAULT_STOP_VALUES)) + E2E_MARGIN_MS;
export const E2E_SUPERVISOR_CLOSE_BOUND_MS = supervisorMaxCloseMs(E2E_DRAIN_TIMEOUT_MS, DEFAULT_STOP_VALUES) + ENTRY_HARD_EXIT_MARGIN_MS + E2E_MARGIN_MS;
export const E2E_REAP_CLOSE_BOUND_MS = SHUTDOWN_RELEASE_BOUND_MS + E2E_MARGIN_MS;
export const E2E_CANCEL_TERM_BOUND_MS = E2E_MARGIN_MS;
export const E2E_CANCEL_SWEEP_BOUND_MS = SWEEP_INTERVAL_MS + E2E_MARGIN_MS;
export const E2E_CANCEL_KILL_BOUND_MS = SANDBOX_KILL_GRACE_MS + E2E_MARGIN_MS;
export const E2E_CANCEL_STREAM_BOUND_MS = GATEWAY_CANCEL_TIMEOUT_MS + CANCEL_UPSTREAM_SETTLE_MS + E2E_MARGIN_MS;
export const E2E_ORPHAN_GRACE_MS = 3000;
export const E2E_REAP_TO_RUNNING_BOUND_MS = e2eStartBoundMs({ runtime: { drainTimeoutMs: E2E_DRAIN_TIMEOUT_MS }, orphanGraceMs: E2E_ORPHAN_GRACE_MS });
export const E2E_PHASE2_REACHED_BOUND_MS = orphanPhaseOneBoundMs(resolveStartTiming({ runtime: { drainTimeoutMs: E2E_DRAIN_TIMEOUT_MS }, orphanGraceMs: E2E_ORPHAN_GRACE_MS })) + E2E_MARGIN_MS;
export const E2E_LOCK_FREE_BOUND_MS = LOCK_WATCH_INTERVAL_MS + E2E_RESTART_BOUND_MS;
export const E2E_RUN_COMPLETED_BOUND_MS = E2E_RECOVERY_BOUND_MS + E2E_MARGIN_MS;
export const E2E_TEST_WAIT_BOUNDS_MS = {
  E2E_RESTART_BOUND_MS,
  E2E_RECOVERY_BOUND_MS,
  E2E_SETTINGS_SEEN_BOUND_MS,
  E2E_SETTINGS_RESTART_BOUND_MS,
  E2E_ORPHAN_CLOSE_BOUND_MS,
  E2E_SUPERVISOR_CLOSE_BOUND_MS,
  E2E_REAP_CLOSE_BOUND_MS,
  E2E_CANCEL_TERM_BOUND_MS,
  E2E_CANCEL_SWEEP_BOUND_MS,
  E2E_CANCEL_KILL_BOUND_MS,
  E2E_CANCEL_STREAM_BOUND_MS,
  E2E_REAP_TO_RUNNING_BOUND_MS,
  E2E_PHASE2_REACHED_BOUND_MS,
  E2E_LOCK_FREE_BOUND_MS,
  E2E_RUN_COMPLETED_BOUND_MS,
} as const;
export const e2eTestTimeoutMs = (...sequentialBoundsMs: readonly number[]): number => sequentialBoundsMs.reduce((sum, boundMs) => sum + boundMs, 0) + E2E_MARGIN_MS;
export const E2E_LONGEST_WAIT_MS = Math.max(...Object.values(E2E_TEST_WAIT_BOUNDS_MS));
export const E2E_TEST_TIMEOUT_MS = e2eTestTimeoutMs(E2E_READY_DEADLINE_MS, E2E_LONGEST_WAIT_MS, E2E_SUPERVISOR_CLOSE_BOUND_MS);
export const E2E_SOLVER_LOAD_ALLOWANCE_MS = STARTUP_TIMEOUT_MS + E2E_MARGIN_MS;
export const policyVerifyBoundMs = async (): Promise<number> => (await daemonReadyBoundMs()) + E2E_SOLVER_LOAD_ALLOWANCE_MS + VERIFY_BUDGET_MS;
export const newerClientRunBoundMs = async (): Promise<number> => (await daemonReadyBoundMs()) + E2E_RUN_COMPLETED_BOUND_MS;
export const UNTIL_DEFAULT_INTERVAL_MS = 20;

export type Truthy<T> = Exclude<T, false | null | undefined | 0 | ''>;

export type UntilOptions = { deadlineMs: number; intervalMs?: number; description: string; signal?: AbortSignal };

export const abortableWait = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

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
    await abortableWait(Math.min(intervalMs, remaining));
  }
};
