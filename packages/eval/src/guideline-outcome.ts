import { canonicalJson, defineProductSchema, parseOutsideJson, sha256Hex } from '@momonga/foundation';
import type { ProductValidator } from '@momonga/foundation';
import { GUIDELINE_TEXT_PATTERN } from '@momonga/protocol';
import { GATE_CHECKS } from './context-compare.ts';
import type { ContextComparison } from './context-compare.ts';
import { CONTEXT_MODELS } from './context-report.ts';
import type { ContextModel } from './context-report.ts';
import { IMPROVE_STATUSES } from './context-improve.ts';
import type { ImproveOutcome, ImproveStatus, SkippedScenario } from './context-improve.ts';
import { describeFirstError } from './dataset.ts';
import { EvalError } from './runner.ts';

export const GUIDELINE_OUTCOME_FORMAT = 'momonga-guideline-outcome/1';

export type OutcomeCandidate = { index: number; text?: string; skipped?: string; contrastiveFailures?: number; gate?: ContextComparison['gate'] };

export type GuidelineOutcomeBody = {
  format: typeof GUIDELINE_OUTCOME_FORMAT;
  status: ImproveStatus;
  model: ContextModel;
  alias: string;
  seed: number;
  candidateCount: number;
  dataset: { name: string; digest: string };
  parent: number | null;
  parentText: string | null;
  contrastive: string[];
  skipped: SkippedScenario[];
  candidates: OutcomeCandidate[];
  winner?: { index: number; text: string; parent: number | null; contrastiveFailures: number };
  report?: Record<string, unknown>;
  tokens: { benchmark: number; charged: number };
};

export type GuidelineOutcomeFile = { digest: string; outcome: GuidelineOutcomeBody };

export type GuidelineAdoption = { text: string; parent: number | null; parentText: string | null; report: Record<string, unknown> };

const adoptionReportOf = (outcome: ImproveOutcome, datasetName: string): Record<string, unknown> | undefined => {
  const { winner } = outcome;
  if (winner === undefined) return undefined;
  return {
    source: 'context improve',
    dataset: datasetName,
    model: outcome.model,
    alias: outcome.alias,
    seed: outcome.seed,
    candidateIndex: winner.index,
    contrastive: outcome.contrastive,
    baseline: outcome.baseline,
    contrastiveFailures: winner.contrastiveFailures,
    gate: winner.comparison.gate,
    tokens: outcome.tokens,
  };
};

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

const digestOf = (outcome: unknown): string => sha256Hex(canonicalJson(outcome));

export const outcomeFileOf = (outcome: ImproveOutcome, dataset: { name: string; digest: string }): GuidelineOutcomeFile => {
  const report = adoptionReportOf(outcome, dataset.name);
  const { winner } = outcome;
  const body = plain({
    format: GUIDELINE_OUTCOME_FORMAT,
    status: outcome.status,
    model: outcome.model,
    alias: outcome.alias,
    seed: outcome.seed,
    candidateCount: outcome.candidateCount,
    dataset,
    parent: outcome.current?.version ?? null,
    parentText: outcome.current?.text ?? null,
    contrastive: outcome.contrastive,
    skipped: outcome.skipped,
    candidates: outcome.candidates.map((candidate) => ({
      index: candidate.index,
      text: candidate.text,
      skipped: candidate.skipped,
      contrastiveFailures: candidate.contrastiveFailures,
      gate: candidate.comparison?.gate,
    })),
    winner: winner === undefined ? undefined : { index: winner.index, text: winner.text, parent: winner.parent, contrastiveFailures: winner.contrastiveFailures },
    report,
    tokens: outcome.tokens,
  }) as GuidelineOutcomeBody;
  return { digest: digestOf(body), outcome: body };
};

export const encodeOutcomeFile = (file: GuidelineOutcomeFile): string => `${JSON.stringify(file, null, 2)}\n`;

const HEX_DIGEST = '^[0-9a-f]{64}$';

const nullableVersion = { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] } as const;

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;

const count = { type: 'integer', minimum: 0 } as const;

const tokens = {
  type: 'object',
  properties: { benchmark: { type: 'number', minimum: 0 }, charged: { type: 'number', minimum: 0 } },
  required: ['benchmark', 'charged'],
  additionalProperties: false,
} as const;

const gate = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { enum: [...GATE_CHECKS] }, passed: { type: 'boolean' }, detail: { type: 'string' } },
        required: ['name', 'passed', 'detail'],
        additionalProperties: false,
      },
    },
  },
  required: ['passed', 'checks'],
  additionalProperties: false,
} as const;

const modelKind = { enum: [...CONTEXT_MODELS] } as const;

const stringList = { type: 'array', items: { type: 'string' } } as const;

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    source: { const: 'context improve' },
    dataset: { type: 'string' },
    model: modelKind,
    alias: { type: 'string' },
    seed: { type: 'integer' },
    candidateIndex: count,
    contrastive: stringList,
    baseline: {
      type: 'object',
      properties: { contrastiveFailures: count, compactedScenarios: count, tokens: { type: 'number', minimum: 0 } },
      required: ['contrastiveFailures', 'compactedScenarios', 'tokens'],
      additionalProperties: false,
    },
    contrastiveFailures: count,
    gate,
    tokens,
  },
  required: ['source', 'dataset', 'model', 'alias', 'seed', 'candidateIndex', 'contrastive', 'baseline', 'contrastiveFailures', 'gate', 'tokens'],
  additionalProperties: false,
} as const;

const CANDIDATE_SCHEMA = {
  type: 'object',
  properties: { index: count, text: { type: 'string' }, skipped: { type: 'string' }, contrastiveFailures: count, gate },
  required: ['index'],
  additionalProperties: false,
} as const;

const OUTCOME_FILE_SCHEMA = {
  type: 'object',
  properties: {
    digest: { type: 'string', pattern: HEX_DIGEST },
    outcome: {
      type: 'object',
      properties: {
        format: { const: GUIDELINE_OUTCOME_FORMAT },
        status: { enum: [...IMPROVE_STATUSES] },
        model: modelKind,
        alias: { type: 'string' },
        seed: { type: 'integer' },
        candidateCount: count,
        dataset: {
          type: 'object',
          properties: { name: { type: 'string' }, digest: { type: 'string', pattern: HEX_DIGEST } },
          required: ['name', 'digest'],
          additionalProperties: false,
        },
        parent: nullableVersion,
        parentText: nullableString,
        contrastive: stringList,
        skipped: {
          type: 'array',
          items: { type: 'object', properties: { scenario: { type: 'string' }, reason: { type: 'string' } }, required: ['scenario', 'reason'], additionalProperties: false },
        },
        candidates: { type: 'array', items: CANDIDATE_SCHEMA },
        winner: {
          type: 'object',
          properties: {
            index: { type: 'integer', minimum: 0 },
            text: { type: 'string', minLength: 1, pattern: GUIDELINE_TEXT_PATTERN },
            parent: nullableVersion,
            contrastiveFailures: { type: 'integer', minimum: 0 },
          },
          required: ['index', 'text', 'parent', 'contrastiveFailures'],
          additionalProperties: false,
        },
        report: REPORT_SCHEMA,
        tokens,
      },
      required: ['format', 'status', 'model', 'alias', 'seed', 'candidateCount', 'dataset', 'parent', 'parentText', 'contrastive', 'skipped', 'candidates', 'tokens'],
      additionalProperties: false,
    },
  },
  required: ['digest', 'outcome'],
  additionalProperties: false,
} as const;

const validateOutcomeFile: ProductValidator<GuidelineOutcomeFile> = defineProductSchema('eval/guideline-outcome', OUTCOME_FILE_SCHEMA);

export const parseOutcomeFile = (text: string): GuidelineOutcomeFile => {
  let value: unknown;
  try {
    value = parseOutsideJson(text);
  } catch (error) {
    throw new EvalError(`the outcome file is not JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const verdict = validateOutcomeFile(value);
  if (!verdict.valid) throw new EvalError(`the outcome file is not a ${GUIDELINE_OUTCOME_FORMAT} file: ${describeFirstError(verdict.errors)}`);
  const file = verdict.value;
  if (digestOf(file.outcome) !== file.digest) {
    throw new EvalError('the outcome file was changed after context improve wrote it: its digest does not match its content, so the text in it is not the text that was measured');
  }
  return file;
};

export const adoptionOf = (file: GuidelineOutcomeFile): GuidelineAdoption => {
  const { winner, report, parent, parentText } = file.outcome;
  if (winner === undefined || report === undefined) throw new EvalError('the outcome file has no winner, so there is nothing to adopt');
  if (winner.parent !== parent) throw new EvalError('the outcome file names two different parents for its winner');
  return { text: winner.text, parent, parentText, report };
};
