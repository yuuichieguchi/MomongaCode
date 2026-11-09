import {
  CHILD_STDIO_FLUSH_MS,
  CONTROL_REQUEST_TIMEOUT_MS,
  KILL_CONFIRM_MS,
  ORPHAN_REAP_GRACE_MS,
  RUNTIME_ABORT_BUDGET_MS,
  RUNTIME_TEARDOWN_BUDGET_MS,
  SHUTDOWN_REAP_BOUND_MS,
  SHUTDOWN_RELEASE_BOUND_MS,
  FIRST_GENERATION,
  STARTUP_TIMEOUT_MS,
} from '@momonga/foundation';

export { CONTROL_REQUEST_TIMEOUT_MS, KILL_CONFIRM_MS, ORPHAN_REAP_GRACE_MS, SHUTDOWN_REAP_BOUND_MS, SHUTDOWN_RELEASE_BOUND_MS, STARTUP_TIMEOUT_MS };

export const SUPERVISOR_GENERATION = FIRST_GENERATION;

export const STARTUP_KILL_GRACE_MS = 10_000;
export const RESTART_BASE_MS = 500;
export const RESTART_MAX_MS = 30_000;
export const RESTART_MIN_MS = 100;
export const STABLE_AFTER_MS = 60_000;
export const LOCK_WATCH_INTERVAL_MS = 500;
export const LOCK_WAIT_DEADLINE_MS = 14_000;
export const EXTERNAL_POLL_MS = 5000;
export const ORPHAN_POLL_MS = 250;
export const HELD_RETRY_MS = 300_000;
export const SETTINGS_DEBOUNCE_MS = 200;
export const SETTINGS_POLL_MS = 2000;
export const STDIO_FLUSH_MS = CHILD_STDIO_FLUSH_MS;
export const OUTPUT_MAX_LINES_PER_SECOND = 200;
export const OUTPUT_MAX_BYTES_PER_MINUTE = 1_048_576;
export const DAEMON_MARKER_KILL_GRACE_MS = 2000;
export const HELD_REASON_MAX_CHARS = 200;
export const CONTROL_CLOSE_ALL_AFTER_MS = 1000;
export const SHUTDOWN_BODY_LIMIT_BYTES = 1024;
export const LINE_MAX_BYTES = 65_536;
export const RAW_MAX_BYTES = 8192;

export type SupervisorIntervals = {
  lockWatchIntervalMs: number;
  externalPollMs: number;
  orphanPollMs: number;
  stdioFlushMs: number;
  killConfirmMs: number;
  settingsDebounceMs: number;
  settingsPollMs: number;
};

export const DEFAULT_INTERVALS: SupervisorIntervals = {
  lockWatchIntervalMs: LOCK_WATCH_INTERVAL_MS,
  externalPollMs: EXTERNAL_POLL_MS,
  orphanPollMs: ORPHAN_POLL_MS,
  stdioFlushMs: STDIO_FLUSH_MS,
  killConfirmMs: KILL_CONFIRM_MS,
  settingsDebounceMs: SETTINGS_DEBOUNCE_MS,
  settingsPollMs: SETTINGS_POLL_MS,
};

export const resolveIntervals = (overrides: Partial<SupervisorIntervals> = {}): SupervisorIntervals => ({ ...DEFAULT_INTERVALS, ...overrides });

export type SupervisorTimers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const SUPERVISOR_SERVICE = 'supervisor';
