import { EXIT_ALREADY_RUNNING, EXIT_CONFIG, EXIT_OK, EXIT_RETIRED, computeBackoff, markerReapClockBoundMs } from '@momonga/foundation';
import type { SupervisorExitReason } from '@momonga/protocol';
import { DAEMON_MARKER_KILL_GRACE_MS, RESTART_BASE_MS, RESTART_MAX_MS, RESTART_MIN_MS, STABLE_AFTER_MS, STARTUP_KILL_GRACE_MS } from './constants.ts';

export type RestartPolicy = {
  baseMs: number;
  maxMs: number;
  minMs: number;
  stableAfterMs: number;
  startupKillGraceMs: number;
};

export type StopReason = 'shutdown' | 'startup-timeout' | 'ready-mismatch';

export type StopMode = 'term' | 'int';

export type ExitClass = 'requested' | 'unexpected-clean' | 'failure' | 'signal' | 'lock-held' | 'config' | 'retired';

export type ExitClassification = { class: ExitClass; reason: SupervisorExitReason };

export type ExitDecision =
  | { next: 'stopped' }
  | { next: 'backoff'; delayMs: number }
  | { next: 'waiting-lock' }
  | { next: 'held-config' };

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  baseMs: RESTART_BASE_MS,
  maxMs: RESTART_MAX_MS,
  minMs: RESTART_MIN_MS,
  stableAfterMs: STABLE_AFTER_MS,
  startupKillGraceMs: STARTUP_KILL_GRACE_MS,
};

export const resolveRestartPolicy = (overrides: Partial<RestartPolicy> = {}): RestartPolicy => ({ ...DEFAULT_RESTART_POLICY, ...overrides });

const STOP_REASON_RANKS = {
  shutdown: 2,
  'startup-timeout': 1,
  'ready-mismatch': 1,
} as const satisfies Record<StopReason, number>;

export const stopReasonRank = (reason: StopReason): number => STOP_REASON_RANKS[reason];

const classifyStopReason = (stop: StopReason): ExitClassification => {
  switch (stop) {
    case 'shutdown':
      return { class: 'requested', reason: 'requested' };
    case 'startup-timeout':
      return { class: 'failure', reason: 'startup-timeout' };
    case 'ready-mismatch':
      return { class: 'failure', reason: 'protocol-violation' };
  }
};

export const classifyExit = (input: { code: number | null; signal: NodeJS.Signals | null; stop: StopReason | undefined }): ExitClassification => {
  if (input.stop !== undefined) return classifyStopReason(input.stop);
  if (input.signal !== null) return { class: 'signal', reason: 'signal' };
  switch (input.code) {
    case EXIT_OK:
      return { class: 'unexpected-clean', reason: 'unexpected-clean' };
    case EXIT_ALREADY_RUNNING:
      return { class: 'lock-held', reason: 'lock-held' };
    case EXIT_CONFIG:
      return { class: 'config', reason: 'config' };
    case EXIT_RETIRED:
      return { class: 'retired', reason: 'retired' };
    default:
      return { class: 'failure', reason: 'failure' };
  }
};

export const failureWithoutProcess = (reason: 'spawn-failed' | 'settings-read-failed'): ExitClassification => ({ class: 'failure', reason });

export const backoffDelay = (input: { consecutiveFailures: number; policy: RestartPolicy; random: () => number }): number =>
  Math.max(
    input.policy.minMs,
    computeBackoff({ attempt: input.consecutiveFailures, baseMs: input.policy.baseMs, maxMs: input.policy.maxMs, random: { float: input.random } }),
  );

export const decideAfterExit = (input: { exit: ExitClassification; consecutiveFailures: number; policy: RestartPolicy; random: () => number }): ExitDecision => {
  switch (input.exit.class) {
    case 'requested':
    case 'retired':
      return { next: 'stopped' };
    case 'lock-held':
      return { next: 'waiting-lock' };
    case 'config':
      return { next: 'held-config' };
    case 'unexpected-clean':
    case 'failure':
    case 'signal':
      return { next: 'backoff', delayMs: backoffDelay(input) };
  }
};

export const childRestartBoundMs = (input: { policy: RestartPolicy; startupTimeoutMs: number; stdioFlushMs: number }): number =>
  input.stdioFlushMs + markerReapClockBoundMs(DAEMON_MARKER_KILL_GRACE_MS) + Math.max(input.policy.minMs, input.policy.maxMs) + input.startupTimeoutMs;
