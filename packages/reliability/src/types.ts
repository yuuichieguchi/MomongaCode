import type { PermissionMode, RunFactsAnswers, RunFactsBasis, RunFactsDenials, RunFactsLimits, RunFactsView, RunStatus, StopReason } from '@momonga/protocol';

export type RunFacts = RunFactsView;

export type RunInfo = {
  runId: string;
  rootRunId: string;
  sessionId: string;
  status: RunStatus;
  stopReason?: StopReason;
  createdAt: number;
  limits: RunFactsLimits;
  deadlineAt?: number;
  step: number;
  tokensTotal: number;
  costNano: number;
  model: string;
  mode: PermissionMode;
  agent: string;
  origin: string;
};

export const RUN_GROUP_KEYS = ['model', 'mode', 'agent', 'origin', 'period'] as const;

export const TASK_LABEL_KEYS = ['taskType', 'difficulty'] as const;

export const GROUP_KEYS = [...RUN_GROUP_KEYS, ...TASK_LABEL_KEYS] as const;

export type GroupKey = (typeof GROUP_KEYS)[number];

export type RunGroupKey = (typeof RUN_GROUP_KEYS)[number];

export type TaskLabelKey = (typeof TASK_LABEL_KEYS)[number];

export type TaskLabels = Record<TaskLabelKey, string>;

export type Rate = { k: number; n: number };

export type PermissionFigures = { basis: RunFactsBasis; asks: number; answers: RunFactsAnswers; denials: RunFactsDenials };

export type Indicators = {
  buckets: { counted: number; cancelled: number; pendingFacts: number; factsUnavailable: number; unknownValues: number; notPlaced: number };
  completion: { k: number; n: number; undeclared: number };
  recovery: { k: number; n: number; unknownEffect: number; failed: number; stopped: number };
  recoveryTime: { n: number; meanMs: number | null; medianMs: number | null; clockSkew: number };
  duplicates: { journal: Rate; prevented: number; unknown: number };
  intervention: Rate;
  overrun: { k: number; n: number; budgetStops: number; money: Rate };
  delegation: {
    n: number;
    intervened: number;
    unattended: number;
    waited: number;
    held: number;
    denied: number;
    resolvedHolds: number;
    holdLatencyMs: number;
    workDuringHolds: { modelSteps: number; toolCalls: number };
  };
  time: { n: number; meanActiveMs: number | null; meanElapsedMs: number | null };
  permissions: Record<string, PermissionFigures>;
  verification: { firstRoundPassed: Rate; failedRound: Rate; coverage: Rate; checkMs: number; elapsedMs: number; fixRoundTokens: number };
};

export type IndicatorGroups = { total: Indicators; groups: Record<string, Indicators> };
