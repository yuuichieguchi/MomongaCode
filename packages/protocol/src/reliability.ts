import type { Stored } from './stored-value.ts';
import type { ApprovalBasis } from './permission-denial.ts';
import type { PermissionMode, RunStatus, SideEffect, StopReason } from './run-types.ts';

export const RELIABILITY_FORMAT = 'momonga-reliability/1';
export const MIN_RATE_POPULATION = 35;
export const REVIEW_SAMPLE_SIZE = 73;
export const REPORT_PAGE_ROWS = 500;
export const FACTS_SWEEP_BATCH_RUNS = 3;
export const INDICATOR_DEFINITIONS_VERSION = 1;

export const MAIN_AGENT = 'main';

export const RECOVERY_CAUSES = ['worker_failure', 'process_lost'] as const;
export const RECOVERY_OUTCOMES = ['recovered', 'unknown_effect', 'failed', 'stopped'] as const;

export type RecoveryCause = (typeof RECOVERY_CAUSES)[number];
export type RecoveryOutcome = (typeof RECOVERY_OUTCOMES)[number];

export type RecoveryEpisodeView = {
  ordinal: number;
  cause: Stored<RecoveryCause>;
  failedAt: number;
  progressAt: number | null;
  outcome: Stored<RecoveryOutcome>;
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
  mode: Stored<PermissionMode>;
  agent: string;
  origin: string;
  status: Stored<RunStatus>;
  stopReason?: Stored<StopReason>;
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

export type RunCallView = { runId: string; callId: string; basis: Stored<ApprovalBasis> | null; sideEffect: Stored<SideEffect> | null; asked: boolean };

export type RunFactsRecord = { facts: RunFactsView; calls: RunCallView[] };

export type UnavailableRunView = { runId: string; rootRunId: string };

export type ReportPage = { rows: RunFactsView[]; unavailable: UnavailableRunView[]; nextCursor: string | null };
