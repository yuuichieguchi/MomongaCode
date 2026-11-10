import type { Stored } from './stored-value.ts';
import type { ApprovalBasis } from './permission-denial.ts';
import type { PermissionMode, RunStatus, SideEffect, StopReason } from './run-types.ts';

export const RELIABILITY_FORMAT = 'momonga-reliability/3';

export const RETIRED_RELIABILITY_FORMATS: Readonly<Record<string, string>> = {
  'momonga-reliability/1': 'the tasks whose run facts hold a value the build does not know',
  'momonga-reliability/2': 'the model of each run (it was recorded as an alias name)',
};
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

export const REVIEW_LABELS = ['correct', 'unneeded_ask', 'missed_ask'] as const;
export type ReviewLabel = (typeof REVIEW_LABELS)[number];

export type PermissionReviewView = { runId: string; callId: string; label: Stored<ReviewLabel>; reviewedAt: number };

export type ReviewPage = { calls: RunCallView[]; reviews: PermissionReviewView[]; nextCursor: string | null };

export type StoreReviewRequest = { runId: string; callId: string; label: ReviewLabel };

export type StoreReviewResponse = { review: PermissionReviewView };

export const COST_CURRENCY = 'USD';

export type RunCostView = { runId: string; calls: number; notPriced: number; priced: { currency: typeof COST_CURRENCY; priceVersion: string; units: string }[] };

export type ReportCostRequest = { runIds: string[] };

export type ReportCostPage = { costs: RunCostView[] };

export const MAX_TRACE_CONTENT_PAGE = 50;

export type TraceContentView = { id: number; spanId: string; kind: string; content: string; createdAtMs: number; expiresAtMs: number };

export type TraceContentPage = { bodies: TraceContentView[]; next: number | null };

const text = { type: 'string', minLength: 1 } as const;
const count = { type: 'integer', minimum: 0 } as const;
const nullable = (schema: Record<string, unknown>): Record<string, unknown> => ({ anyOf: [schema, { type: 'null' }] });
const closed = (properties: Record<string, unknown>): Record<string, unknown> => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const review = closed({ runId: text, callId: text, label: text, reviewedAt: count });

export const REPORT_SCHEMAS = {
  ReviewPage: closed({
    calls: { type: 'array', items: closed({ runId: text, callId: text, basis: nullable(text), sideEffect: nullable(text), asked: { type: 'boolean' } }) },
    reviews: { type: 'array', items: review },
    nextCursor: nullable(text),
  }),
  StoreReviewRequest: closed({ runId: text, callId: text, label: { enum: [...REVIEW_LABELS] } }),
  StoreReviewResponse: closed({ review }),
  ReportCostRequest: closed({ runIds: { type: 'array', maxItems: REPORT_PAGE_ROWS, uniqueItems: true, items: text } }),
  ReportCostPage: closed({
    costs: {
      type: 'array',
      items: closed({
        runId: text,
        calls: count,
        notPriced: count,
        priced: { type: 'array', items: closed({ currency: { const: COST_CURRENCY }, priceVersion: text, units: { type: 'string', pattern: '^[0-9]+$' } }) },
      }),
    },
  }),
  TraceContentPage: closed({
    bodies: { type: 'array', items: closed({ id: count, spanId: text, kind: text, content: { type: 'string' }, createdAtMs: count, expiresAtMs: count }) },
    next: nullable(count),
  }),
} as const satisfies Record<string, Record<string, unknown>>;
