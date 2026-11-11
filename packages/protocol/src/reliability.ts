import type { Stored } from './stored-value.ts';
import { boolean, closedRequiringAll, nonEmptyString, nonNegativeInteger, nullable, string } from './schema-helpers.ts';
import type { JsonSchema } from './schema-helpers.ts';
import type { ApprovalBasis } from './permission-denial.ts';
import type { PermissionMode, RunStatus, SideEffect, StopReason } from './run-types.ts';

export const RELIABILITY_FORMAT = 'momonga-reliability/5';

export const RETIRED_RELIABILITY_FORMATS: Readonly<Record<string, string>> = {
  'momonga-reliability/1': 'the tasks whose run facts hold a value the build does not know',
  'momonga-reliability/2': 'the model of each run (it was recorded as an alias name)',
  'momonga-reliability/3': 'the money limit in the budget overrun and the figures of mandate runs',
  'momonga-reliability/4': 'the root runs a period or a grouping could not place and the runs without cost data',
};
export const MIN_RATE_POPULATION = 35;
export const REVIEW_SAMPLE_SIZE = 73;
export const REPORT_PAGE_ROWS = 500;
export const FACTS_SWEEP_BATCH_RUNS = 3;
export const INDICATOR_DEFINITIONS_VERSION = 3;

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

export type RunCostView = { runId: string; calls: number; notPriced: number; legacyPrecisionCalls: number; priced: { currency: typeof COST_CURRENCY; priceVersion: string; units: string }[] };

export type ReportCostRequest = { runIds: string[] };

export type ReportCostPage = { costs: RunCostView[] };

export type ReportRecomputeRequest = { runIds: string[] };

export type ReportRecomputePage = { rows: RunFactsView[]; refused: string[] };

export const MAX_TRACE_CONTENT_PAGE = 50;

export const TRACE_CONTENT_PAGE_OPTION = { flag: '--page-size', minimum: 1, maximum: MAX_TRACE_CONTENT_PAGE, default: MAX_TRACE_CONTENT_PAGE } as const;

export const RELIABILITY_DERIVATIONS = {
  RELIABILITY_FORMAT:
    'The name of the stored report form with its version. The version rises by one when a report of the older form cannot be read as the new one, and RETIRED_RELIABILITY_FORMATS says by name what each older form lacks.',
  MIN_RATE_POPULATION:
    'The smallest population whose zero-failure Wilson upper bound at 95% is at most 10%: z^2 / (n + z^2) with z = 1.959963984540054 gives 9.9% at n = 35 and more than 10% at n = 34. Below it a rate is printed as counts.',
  REVIEW_SAMPLE_SIZE:
    'The smallest number of reviewed calls whose zero-miss Wilson upper bound at 95% is at most 5%: z^2 / (n + z^2) with z = 1.959963984540054 gives 5.0% at n = 73. It is the size of permissions review --sample when no number is given.',
  REPORT_PAGE_ROWS:
    'Equal to MAX_BILLED_CALLS_PAGE, the bound the billed-call paging of the cost report already uses. A facts row carries columns only and no payload JSON, and one cost request names at most this many runs.',
  FACTS_SWEEP_BATCH_RUNS:
    'Equal to SEARCH_INDEX_BATCH_RUNS: the bounded background folds of the daemon share one cadence, and each run of a tick costs one journal thread request.',
  INDICATOR_DEFINITIONS_VERSION:
    'A counter, not a measure: a change to any indicator formula raises it by one, and stored run facts of an older version are folded again. 2 is the set of formulas that has the money limit in the Budget Overrun Rate and the figures of mandate runs.',
  MAIN_AGENT: 'The name under which a report groups the work a root run did itself, beside the names of its subagents. A product word, not a measure.',
  COST_CURRENCY:
    'The one currency of the product: every price of the price table is stated in US dollars, so a cost is never converted and a report never adds amounts of two currencies.',
  COST_UNIT_DIGITS: 'Derived: the decimal places of one US dollar in units of the price table, log10(NANO_PER_USD x PRICE_UNITS_PER_NANO) = 9 + 6.',
  MAX_TRACE_CONTENT_PAGE:
    'The most stored message bodies one request for the content of a trace returns. A product choice with no formula: a body has no size bound of its own, so no byte budget fixes the count, and it bounds only the rows of one read. trace --content --page-size reads fewer bodies per request, from 1 to this value, and this value when omitted.',
  'permissions review --sample needs --seed':
    'The sample is the first calls in an order fixed by the call and the seed, so the seed is what lets a person come back to a sample: the same seed lists the same calls again, and without one a second listing could not be matched to the labels already stored.',
  'trace --content --json':
    'One JSON object per line, one line per stored body, because the content is read page by page and written as each page arrives: the whole content of a run is never held in memory, and a reader may stop after any line.',
} as const satisfies Record<string, string>;

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
  ReportRecomputeRequest: closedRequiringAll({ runIds: { type: 'array', maxItems: REPORT_PAGE_ROWS, uniqueItems: true, items: nonEmptyString } }),
  ReportCostPage: closedRequiringAll({
    costs: {
      type: 'array',
      items: closedRequiringAll({
        runId: nonEmptyString,
        calls: nonNegativeInteger,
        notPriced: nonNegativeInteger,
        legacyPrecisionCalls: nonNegativeInteger,
        priced: { type: 'array', items: closedRequiringAll({ currency: { const: COST_CURRENCY }, priceVersion: nonEmptyString, units: { type: 'string', pattern: '^[0-9]+$' } }) },
      }),
    },
  }),
  TraceContentPage: closedRequiringAll({
    bodies: { type: 'array', items: closedRequiringAll({ id: nonNegativeInteger, spanId: nonEmptyString, kind: nonEmptyString, content: string, createdAtMs: nonNegativeInteger, expiresAtMs: nonNegativeInteger }) },
    next: nullable(nonNegativeInteger),
  }),
} as const satisfies Record<string, JsonSchema>;
