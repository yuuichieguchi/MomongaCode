import type { Stored } from './stored-value.ts';
import { boolean, closedRequiringAll, nonEmptyString, nonNegativeInteger, nullable, string } from './schema-helpers.ts';
import type { JsonSchema } from './schema-helpers.ts';
import type { ApprovalBasis } from './permission-denial.ts';
import type { PermissionMode, RunStatus, SideEffect, StopReason } from './run-types.ts';

export const RELIABILITY_FORMAT = 'momonga-reliability/4';

export const RETIRED_RELIABILITY_FORMATS: Readonly<Record<string, string>> = {
  'momonga-reliability/1': 'the tasks whose run facts hold a value the build does not know',
  'momonga-reliability/2': 'the model of each run (it was recorded as an alias name)',
  'momonga-reliability/3': 'the money limit in the budget overrun and the figures of mandate runs',
};
export const MIN_RATE_POPULATION = 35;
export const REVIEW_SAMPLE_SIZE = 73;
export const REPORT_PAGE_ROWS = 500;
export const FACTS_SWEEP_BATCH_RUNS = 3;
export const INDICATOR_DEFINITIONS_VERSION = 2;

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

export type RunFactsLimits = { maxSteps?: number; maxTotalTokens?: number; maxCostNano?: number };

export type RunFactsDelegation = { held: number; resolvedByPerson: number; denied: number; waited: boolean };

export type RunFactsBasis = { readOnly: number; rule: number; mode: number; hook: number; classifier: number; person: number };

export type RunFactsView = {
  runId: string;
  rootRunId: string;
  sessionId: string;
  definitionsVersion: number;
  model: string;
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
  costNano: number;
  steps: number;
  limits: RunFactsLimits;
  delegation?: RunFactsDelegation;
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

export const REVIEW_LABELS = ['correct', 'unneeded_ask', 'missed_ask'] as const;
export type ReviewLabel = (typeof REVIEW_LABELS)[number];

export type PermissionReviewView = { runId: string; callId: string; label: Stored<ReviewLabel>; reviewedAt: number };

export type ReviewPage = { calls: RunCallView[]; reviews: PermissionReviewView[]; nextCursor: string | null };

export type StoreReviewRequest = { runId: string; callId: string; label: ReviewLabel };

export type StoreReviewResponse = { review: PermissionReviewView };

export const COST_CURRENCY = 'USD';
export const COST_UNIT_DIGITS = 15;

export type RunCostView = { runId: string; calls: number; notPriced: number; priced: { currency: typeof COST_CURRENCY; priceVersion: string; units: string }[] };

export type ReportCostRequest = { runIds: string[] };

export type ReportCostPage = { costs: RunCostView[] };

export const MAX_TRACE_CONTENT_PAGE = 50;

export type TraceContentView = { id: number; spanId: string; kind: string; content: string; createdAtMs: number; expiresAtMs: number };

export type TraceContentPage = { bodies: TraceContentView[]; next: number | null };

const review = closedRequiringAll({ runId: nonEmptyString, callId: nonEmptyString, label: nonEmptyString, reviewedAt: nonNegativeInteger });

export const REPORT_SCHEMAS = {
  ReviewPage: closedRequiringAll({
    calls: { type: 'array', items: closedRequiringAll({ runId: nonEmptyString, callId: nonEmptyString, basis: nullable(nonEmptyString), sideEffect: nullable(nonEmptyString), asked: boolean }) },
    reviews: { type: 'array', items: review },
    nextCursor: nullable(nonEmptyString),
  }),
  StoreReviewRequest: closedRequiringAll({ runId: nonEmptyString, callId: nonEmptyString, label: { enum: [...REVIEW_LABELS] } }),
  StoreReviewResponse: closedRequiringAll({ review }),
  ReportCostRequest: closedRequiringAll({ runIds: { type: 'array', maxItems: REPORT_PAGE_ROWS, uniqueItems: true, items: nonEmptyString } }),
  ReportCostPage: closedRequiringAll({
    costs: {
      type: 'array',
      items: closedRequiringAll({
        runId: nonEmptyString,
        calls: nonNegativeInteger,
        notPriced: nonNegativeInteger,
        priced: { type: 'array', items: closedRequiringAll({ currency: { const: COST_CURRENCY }, priceVersion: nonEmptyString, units: { type: 'string', pattern: '^[0-9]+$' } }) },
      }),
    },
  }),
  TraceContentPage: closedRequiringAll({
    bodies: { type: 'array', items: closedRequiringAll({ id: nonNegativeInteger, spanId: nonEmptyString, kind: nonEmptyString, content: string, createdAtMs: nonNegativeInteger, expiresAtMs: nonNegativeInteger }) },
    next: nullable(nonNegativeInteger),
  }),
} as const satisfies Record<string, JsonSchema>;
