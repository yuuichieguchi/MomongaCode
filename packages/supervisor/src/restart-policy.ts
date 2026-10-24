import { computeBackoff } from '@momonga/foundation';
import type { SupervisorExitReason } from '@momonga/protocol';
import { RESTART_BASE_MS, RESTART_MAX_MS, RESTART_MIN_MS, STABLE_AFTER_MS, STARTUP_KILL_GRACE_MS } from './constants.ts';

export type RestartPolicy = {
  baseMs: number;
  maxMs: number;
  minMs: number;
  stableAfterMs: number;
  startupKillGraceMs: number;
};

export type StopReason = 'shutdown' | 'plan-restart' | 'startup-timeout' | 'ready-mismatch';

export type StopMode = 'term' | 'int';

export type ExitClass = 'requested' | 'plan-stopped' | 'unexpected-clean' | 'failure' | 'signal' | 'lock-held' | 'config';

export type ExitClassification = { class: ExitClass; reason: SupervisorExitReason };

export type ExitDecision =
  | { next: 'stopped' }
  | { next: 'plan-stopped' }
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
  shutdown: 3,
  'plan-restart': 2,
  'startup-timeout': 1,
  'ready-mismatch': 1,
} as const satisfies Record<StopReason, number>;

export const stopReasonRank = (reason: StopReason): number => STOP_REASON_RANKS[reason];

const classifyStopReason = (stop: StopReason): ExitClassification => {
  switch (stop) {
    case 'shutdown':
      return { class: 'requested', reason: 'requested' };
    case 'plan-restart':
      return { class: 'plan-stopped', reason: 'requested' };
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
    case 0:
      return { class: 'unexpected-clean', reason: 'unexpected-clean' };
    case 75:
      return { class: 'lock-held', reason: 'lock-held' };
    case 78:
      return { class: 'config', reason: 'config' };
    default:
      return { class: 'failure', reason: 'failure' };
  }
};

export const failureWithoutProcess = (reason: 'spawn-failed' | 'settings-read-failed'): ExitClassification => ({ class: 'failure', reason });

export const backoffDelay = (input: { consecutiveFailures: number; policy: RestartPolicy; random: () => number }): number =>
  Math.max(
    input.policy.minMs,
    computeBackoff({ attempt: input.consecutiveFailures, baseMs: input.policy.baseMs, maxMs: input.policy.maxMs, random: input.random }),
  );

export const decideAfterExit = (input: { exit: ExitClassification; consecutiveFailures: number; policy: RestartPolicy; random: () => number }): ExitDecision => {
  switch (input.exit.class) {
    case 'requested':
      return { next: 'stopped' };
    case 'plan-stopped':
      return { next: 'plan-stopped' };
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
