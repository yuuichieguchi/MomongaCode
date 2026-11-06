import type { PermissionMode, RunStatus, StopReason } from './run-types.ts';

export const RELIABILITY_FORMAT = 'momonga-reliability/1';
export const MIN_RATE_POPULATION = 35;
export const REPORT_PAGE_ROWS = 500;
export const FACTS_SWEEP_BATCH_RUNS = 3;
export const INDICATOR_DEFINITIONS_VERSION = 1;

export const RECOVERY_CAUSES = ['worker_failure', 'process_lost'] as const;
export const RECOVERY_OUTCOMES = ['recovered', 'unknown_effect', 'failed', 'stopped'] as const;

export type RecoveryCause = (typeof RECOVERY_CAUSES)[number];
export type RecoveryOutcome = (typeof RECOVERY_OUTCOMES)[number];

export type RecoveryEpisodeView = {
  ordinal: number;
  cause: RecoveryCause;
  failedAt: number;
  progressAt: number | null;
  outcome: RecoveryOutcome;
  startedSeq: number;
  progressSeq: number | null;
};

export type RunFactsLimits = { maxSteps?: number; maxTotalTokens?: number };

export type RunFactsBasis = { readOnly: number; rule: number; mode: number; hook: number; classifier: number; person: number };

export type RunFactsView = {
  runId: string;
  rootRunId: string;
  sessionId: string;
  definitionsVersion: number;
  modelAlias: string;
  mode: PermissionMode;
  agent: string;
  origin: string;
  status: RunStatus;
  stopReason?: StopReason;
  createdAt: number;
  endedAt: number;
  elapsedMs: number;
  humanWaitMs: number;
  tokensTotal: number;
  steps: number;
  limits: RunFactsLimits;
  deadlineAt?: number;
  asked: number;
  elicited: number;
  authorizationRequired: number;
  sideEffectingCalls: number;
  repeatedStarts: number;
  reconciledAlreadyApplied: number;
  reconciledNotApplied: number;
  reconciledUnknown: number;
  basis: RunFactsBasis;
  declared: boolean;
  met: boolean;
  recoveries: RecoveryEpisodeView[];
};

export type ReportPage = { rows: RunFactsView[]; nextCursor: string | null };
