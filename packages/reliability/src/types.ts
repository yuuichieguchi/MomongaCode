import type { PermissionMode, RunFactsLimits, RunFactsView, RunStatus, StopReason } from '@momonga/protocol';

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
  modelAlias: string;
  mode: PermissionMode;
  agent: string;
  origin: string;
};

export const GROUP_KEYS = ['model', 'mode', 'agent', 'origin', 'period'] as const;

export type GroupKey = (typeof GROUP_KEYS)[number];

export type Rate = { k: number; n: number };

export type Indicators = {
  buckets: { counted: number; cancelled: number; pendingFacts: number; factsUnavailable: number; unknownValues: number };
  completion: { k: number; n: number; undeclared: number };
  recovery: { k: number; n: number; unknownEffect: number; failed: number; stopped: number };
  recoveryTime: { n: number; meanMs: number | null; medianMs: number | null; clockSkew: number };
  duplicates: { journal: Rate; prevented: number; unknown: number };
  intervention: Rate;
  overrun: { k: number; n: number; budgetStops: number };
  time: { n: number; meanActiveMs: number | null; meanElapsedMs: number | null };
};

export type IndicatorGroups = { total: Indicators; groups: Record<string, Indicators> };
