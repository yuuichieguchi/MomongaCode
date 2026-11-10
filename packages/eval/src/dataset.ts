import { defineProductSchema, describeFirstError, parseOutsideJson } from '@momonga/foundation';
import type { ProductValidator } from '@momonga/foundation';
import { COMPLETION_DECLARATION_SCHEMA, PERMISSION_MODES, RUN_STATUSES, STOP_REASONS } from '@momonga/protocol';
import type { CompletionDeclaration, PermissionMode, RunStatus, StopReason } from '@momonga/protocol';
import { GATE_VERDICTS } from './oracle.ts';
import type { GateVerdict } from './oracle.ts';
import { ORACLE_CHECKS_SCHEMA } from './oracle-check.ts';
import type { OracleCheck } from './oracle-check.ts';

export const DATASET_FORMAT = 'momonga-eval/1';

export const PERMISSION_DECISIONS = ['allow', 'ask', 'deny'] as const;
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

export const ASK_RESPONSES = ['allow_once', 'reject_once'] as const;
export type AskResponse = (typeof ASK_RESPONSES)[number];

export type CountRange = { min?: number; max?: number };

export type GraderSpec =
  | { kind: 'status'; equals: RunStatus }
  | { kind: 'stopReason'; equals: StopReason }
  | { kind: 'noStopReason' }
  | { kind: 'finalTextEquals'; text: string }
  | { kind: 'finalTextIncludes'; text: string }
  | { kind: 'finalTextMatches'; pattern: string }
  | { kind: 'toolCalled'; name: string; count?: CountRange; inputIncludes?: Record<string, unknown> }
  | { kind: 'toolNotCalled'; name: string }
  | { kind: 'stepsAtMost'; max: number }
  | { kind: 'tokensAtMost'; max: number }
  | { kind: 'permissionDecision'; tool: string; expected: PermissionDecision; inputPattern?: string }
  | { kind: 'verification'; equals: GateVerdict }
  | { kind: 'oracle' };

export type GoldenCase = {
  id: string;
  description?: string;
  input: string;
  permissionMode: PermissionMode;
  onAsk: AskResponse;
  runs: number;
  minPassRate: number;
  timeoutMs?: number;
  files?: Record<string, string>;
  completion?: CompletionDeclaration;
  oracle?: OracleCheck[];
  graders: GraderSpec[];
};

export type GoldenDataset = { format: typeof DATASET_FORMAT; name: string; cases: GoldenCase[] };

export class DatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatasetError';
  }
}

const string = { type: 'string', minLength: 1 } as const;
const countRange = {
  type: 'object',
  properties: { min: { type: 'integer', minimum: 0 }, max: { type: 'integer', minimum: 0 } },
  additionalProperties: false,
} as const;

const grader = (kind: string, properties: Record<string, unknown>, required: readonly string[]) =>
  ({
    type: 'object',
    properties: { kind: { const: kind }, ...properties },
    required: ['kind', ...required],
    additionalProperties: false,
  }) as const;

export const DATASET_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    format: { const: DATASET_FORMAT },
    name: string,
    cases: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
          description: string,
          input: string,
          permissionMode: { enum: [...PERMISSION_MODES] },
          onAsk: { enum: [...ASK_RESPONSES] },
          runs: { type: 'integer', minimum: 1 },
          minPassRate: { type: 'number', minimum: 0, maximum: 1 },
          timeoutMs: { type: 'integer', minimum: 1000 },
          files: { type: 'object', additionalProperties: { type: 'string' } },
          completion: COMPLETION_DECLARATION_SCHEMA,
          oracle: ORACLE_CHECKS_SCHEMA,
          graders: {
            type: 'array',
            minItems: 1,
            items: {
              oneOf: [
                grader('status', { equals: { enum: [...RUN_STATUSES] } }, ['equals']),
                grader('stopReason', { equals: { enum: [...STOP_REASONS] } }, ['equals']),
                grader('noStopReason', {}, []),
                grader('finalTextEquals', { text: { type: 'string' } }, ['text']),
                grader('finalTextIncludes', { text: string }, ['text']),
                grader('finalTextMatches', { pattern: string }, ['pattern']),
                grader('toolCalled', { name: string, count: countRange, inputIncludes: { type: 'object' } }, ['name']),
                grader('toolNotCalled', { name: string }, ['name']),
                grader('stepsAtMost', { max: { type: 'integer', minimum: 0 } }, ['max']),
                grader('tokensAtMost', { max: { type: 'integer', minimum: 0 } }, ['max']),
                grader('permissionDecision', { tool: string, expected: { enum: [...PERMISSION_DECISIONS] }, inputPattern: string }, ['tool', 'expected']),
                grader('verification', { equals: { enum: [...GATE_VERDICTS] } }, ['equals']),
                grader('oracle', {}, []),
              ],
            },
          },
        },
        required: ['id', 'input', 'permissionMode', 'onAsk', 'runs', 'minPassRate', 'graders'],
        additionalProperties: false,
      },
    },
  },
  required: ['format', 'name', 'cases'],
  additionalProperties: false,
} as const;

const validateDataset: ProductValidator<GoldenDataset> = defineProductSchema('eval/dataset', DATASET_SCHEMA);

export { describeFirstError };

type CasesHolder = { cases: readonly GoldenCase[] };

const assertUniqueCaseIds = (dataset: CasesHolder, source: string): void => {
  const seen = new Set<string>();
  for (const golden of dataset.cases) {
    if (seen.has(golden.id)) throw new DatasetError(`${source}: duplicate case id ${golden.id}`);
    seen.add(golden.id);
  }
};

const assertPatternsCompile = (dataset: CasesHolder, source: string): void => {
  for (const golden of dataset.cases) {
    for (const spec of golden.graders) {
      const pattern = spec.kind === 'finalTextMatches' ? spec.pattern : spec.kind === 'permissionDecision' ? spec.inputPattern : undefined;
      if (pattern === undefined) continue;
      try {
        new RegExp(pattern, 'u');
      } catch (error) {
        throw new DatasetError(`${source}: case ${golden.id} has an invalid ${spec.kind} pattern: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
};

export const isInsideWorkspace = (name: string): boolean => {
  const segments = name.split('/');
  return name !== '' && !name.startsWith('/') && !segments.some((segment) => segment === '' || segment === '.' || segment === '..');
};

const assertFilesStayInside = (dataset: CasesHolder, source: string): void => {
  for (const golden of dataset.cases) {
    for (const name of Object.keys(golden.files ?? {})) {
      if (!isInsideWorkspace(name)) {
        throw new DatasetError(`${source}: case ${golden.id} has the fixture file ${JSON.stringify(name)}; fixture names must be relative paths inside the workspace`);
      }
    }
  }
};

const assertCountRanges = (dataset: CasesHolder, source: string): void => {
  for (const golden of dataset.cases) {
    for (const spec of golden.graders) {
      if (spec.kind !== 'toolCalled' || spec.count === undefined) continue;
      const { min, max } = spec.count;
      if (min === undefined && max === undefined) throw new DatasetError(`${source}: case ${golden.id} has a toolCalled count with neither min nor max`);
      if (min !== undefined && max !== undefined && min > max) throw new DatasetError(`${source}: case ${golden.id} has a toolCalled count with min above max`);
    }
  }
};

const assertOracleDeclared = (dataset: CasesHolder, source: string): void => {
  for (const golden of dataset.cases) {
    const ids = (golden.oracle ?? []).map((check) => check.id);
    if (new Set(ids).size !== ids.length) throw new DatasetError(`${source}: case ${golden.id} has two oracle checks with the same id`);
    if (golden.graders.some((spec) => spec.kind === 'oracle') && golden.oracle === undefined) {
      throw new DatasetError(`${source}: case ${golden.id} has an oracle grader but declares no oracle checks`);
    }
  }
};

export const assertGoldenCases = (dataset: CasesHolder, source: string): void => {
  assertOracleDeclared(dataset, source);
  assertUniqueCaseIds(dataset, source);
  assertPatternsCompile(dataset, source);
  assertCountRanges(dataset, source);
  assertFilesStayInside(dataset, source);
};

export const jsonOf = (text: string, source: string): unknown => {
  try {
    return parseOutsideJson(text);
  } catch (error) {
    throw new DatasetError(`${source}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const parseDataset = (text: string, source: string): GoldenDataset => {
  const value = jsonOf(text, source);
  const verdict = validateDataset(value);
  if (!verdict.valid) throw new DatasetError(`${source}: invalid dataset at ${describeFirstError(verdict.errors)}`);
  assertGoldenCases(verdict.value, source);
  return verdict.value;
};
