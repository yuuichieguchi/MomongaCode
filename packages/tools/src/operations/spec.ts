import { defineProductSchema } from '@momonga/foundation';
import type { ToolKind } from '@momonga/protocol';
import { withRefNameRule } from './ref-name.ts';
import { REFERENCE_PATTERN, isTruthy, lookup } from './template.ts';
import type { Scope } from './template.ts';

export class OperationSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationSpecError';
  }
}

export const OPERATION_GUARDS = ['server_unique', 'compare_and_set', 'none'] as const;
export type Guard = (typeof OPERATION_GUARDS)[number];
export const OPERATION_CRASH_POINTS = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'] as const;

export const APPROVAL_CLASSES = ['rule', 'always'] as const;
export type ApprovalClass = (typeof APPROVAL_CLASSES)[number];

export const FORGE_VOCABULARY = ['listPullRequests', 'getPullRequest', 'createPullRequest', 'mergePullRequest', 'getBranch', 'listChecks', 'listComments', 'createComment'] as const;
export type ForgeOperationName = (typeof FORGE_VOCABULARY)[number];

export type Operand = string | { readonly literal: string };
export type Clause = readonly [Operand, Operand];
export type ConditionalClauses = { readonly if: string; readonly then: readonly Clause[]; readonly else: readonly Clause[] };
export type ClauseItem = Clause | ConditionalClauses;

export type ArgvItem = string | { readonly if: string; readonly then: readonly string[]; readonly else?: readonly string[] };
export const NETWORK_TARGETS = ['none', 'destination', 'destinations'] as const;
export type Network = (typeof NETWORK_TARGETS)[number];

export type ArgvCall = { readonly argv: readonly ArgvItem[]; readonly network?: Network };
export type ForgeCall = { readonly forge: ForgeOperationName; readonly args: Readonly<Record<string, string>> };

export type ProbeSource =
  | (ArgvCall & { readonly extract?: 'trim' | 'firstField'; readonly emptyOnFailure?: true; readonly each?: 'pushUrls' })
  | (ForgeCall & { readonly shape: 'one' | 'list' | 'count'; readonly contains?: { readonly field: string; readonly value: string } });

export type Probe = { readonly id: string; readonly via: ProbeSource };

export type SubjectSpec =
  | { readonly kind: 'none' }
  | { readonly kind: 'repo'; readonly remote?: string; readonly refs?: readonly string[]; readonly alwaysWhen?: readonly string[] }
  | { readonly kind: 'forge'; readonly pr?: string; readonly headSha?: string };

export type OperationSpec = {
  readonly name: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly sideEffect: 'read_only' | 'write' | 'exec';
  readonly title: string;
  readonly subject: SubjectSpec;
  readonly approval: ApprovalClass;
  readonly input: Record<string, unknown>;
  readonly timeoutMs: number;
  readonly observe: readonly Probe[];
  readonly require: readonly ClauseItem[];
  readonly effect?: ArgvCall | ForgeCall;
  readonly applied: readonly ClauseItem[];
  readonly unchanged: readonly ClauseItem[];
  readonly guard?: Guard;
  readonly supersedes: ReadonlyArray<readonly string[]>;
  readonly report: string;
};

const REFERENCE = { type: 'string', pattern: REFERENCE_PATTERN } as const;
const OPERAND = { oneOf: [REFERENCE, { type: 'object', properties: { literal: { type: 'string' } }, required: ['literal'], additionalProperties: false }] } as const;
const CLAUSE = { type: 'array', items: OPERAND, minItems: 2, maxItems: 2 } as const;
const CLAUSE_ITEM = {
  oneOf: [
    CLAUSE,
    {
      type: 'object',
      properties: { if: REFERENCE, then: { type: 'array', items: CLAUSE }, else: { type: 'array', items: CLAUSE } },
      required: ['if', 'then', 'else'],
      additionalProperties: false,
    },
  ],
} as const;
const STRINGS = { type: 'array', items: { type: 'string' } } as const;
const ARGV = {
  type: 'array',
  minItems: 1,
  items: {
    oneOf: [{ type: 'string' }, { type: 'object', properties: { if: REFERENCE, then: STRINGS, else: STRINGS }, required: ['if', 'then'], additionalProperties: false }],
  },
} as const;
const NETWORK = { enum: [...NETWORK_TARGETS] } as const;
const STRING_MAP = { type: 'object', additionalProperties: { type: 'string' } } as const;
const FORGE_NAME = { enum: [...FORGE_VOCABULARY] } as const;
const ARGV_CALL = { type: 'object', properties: { argv: ARGV, network: NETWORK }, required: ['argv'], additionalProperties: false } as const;
const FORGE_CALL = { type: 'object', properties: { forge: FORGE_NAME, args: STRING_MAP }, required: ['forge', 'args'], additionalProperties: false } as const;

const SPEC_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    name: { type: 'string', pattern: '^[A-Z][A-Za-z0-9]*$' },
    description: { type: 'string', minLength: 1 },
    kind: { enum: ['read', 'edit', 'search', 'execute', 'fetch', 'other'] },
    sideEffect: { enum: ['read_only', 'write', 'exec'] },
    title: { type: 'string', minLength: 1 },
    subject: {
      oneOf: [
        { type: 'object', properties: { kind: { const: 'none' } }, required: ['kind'], additionalProperties: false },
        {
          type: 'object',
          properties: { kind: { const: 'repo' }, remote: { type: 'string' }, refs: STRINGS, alwaysWhen: STRINGS },
          required: ['kind'],
          additionalProperties: false,
        },
        { type: 'object', properties: { kind: { const: 'forge' }, pr: { type: 'string' }, headSha: { type: 'string' } }, required: ['kind'], additionalProperties: false },
      ],
    },
    approval: { enum: [...APPROVAL_CLASSES] },
    input: { type: 'object' },
    timeoutMs: { type: 'integer', minimum: 1 },
    observe: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9]*$' },
          via: {
            oneOf: [
              {
                type: 'object',
                properties: { argv: ARGV, network: NETWORK, extract: { enum: ['trim', 'firstField'] }, emptyOnFailure: { const: true }, each: { const: 'pushUrls' } },
                required: ['argv'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  forge: FORGE_NAME,
                  args: STRING_MAP,
                  shape: { enum: ['one', 'list', 'count'] },
                  contains: { type: 'object', properties: { field: { type: 'string' }, value: { type: 'string' } }, required: ['field', 'value'], additionalProperties: false },
                },
                required: ['forge', 'args', 'shape'],
                additionalProperties: false,
              },
            ],
          },
        },
        required: ['id', 'via'],
        additionalProperties: false,
      },
    },
    require: { type: 'array', items: CLAUSE_ITEM },
    effect: { oneOf: [ARGV_CALL, FORGE_CALL] },
    applied: { type: 'array', items: CLAUSE_ITEM },
    unchanged: { type: 'array', items: CLAUSE_ITEM },
    guard: { enum: [...OPERATION_GUARDS] },
    supersedes: { type: 'array', items: { type: 'array', items: { type: 'string' }, minItems: 1 } },
    report: { type: 'string', minLength: 1 },
  },
  required: ['name', 'description', 'kind', 'sideEffect', 'title', 'subject', 'approval', 'input', 'timeoutMs', 'observe', 'applied', 'unchanged', 'supersedes', 'report'],
  additionalProperties: false,
} as const;

const validateSpec = defineProductSchema<OperationSpec & { require?: readonly ClauseItem[] }>('tools/operation-spec', SPEC_SCHEMA);

const INPUT_REFERENCE = /\{(input\.[A-Za-z0-9_]+)\}/g;

const inputsIn = (text: string): string[] => [...text.matchAll(INPUT_REFERENCE)].map((match) => match[1] as string);

const subjectInputs = (subject: SubjectSpec): string[] => {
  if (subject.kind === 'none') return [];
  if (subject.kind === 'repo') return [...inputsIn(subject.remote ?? ''), ...(subject.refs ?? []).flatMap(inputsIn), ...(subject.alwaysWhen ?? []).map((flag) => `input.${flag}`)];
  return [...inputsIn(subject.pr ?? ''), ...inputsIn(subject.headSha ?? '')];
};

const isInputOperand = (operand: Operand): operand is string => typeof operand === 'string' && operand.startsWith('input.');

const boundInputs = (effect: ArgvCall | ForgeCall, require: readonly ClauseItem[]): Set<string> => {
  const fromEffect = 'argv' in effect ? effect.argv.flatMap((item) => (typeof item === 'string' ? inputsIn(item) : [item.if, ...item.then.flatMap(inputsIn), ...(item.else ?? []).flatMap(inputsIn)])) : Object.values(effect.args).flatMap(inputsIn);
  const clauses = require.flatMap((item): Clause[] => (Array.isArray(item) ? [item as Clause] : [...(item as ConditionalClauses).then, ...(item as ConditionalClauses).else]));
  return new Set([...fromEffect, ...clauses.flatMap((clause) => clause.filter(isInputOperand))]);
};

export const parseOperationSpec = (value: unknown): OperationSpec => {
  const verdict = validateSpec(value);
  if (!verdict.valid) {
    const first = verdict.errors[0];
    throw new OperationSpecError(`invalid operation spec at ${first?.instancePath === '' ? '/' : (first?.instancePath ?? '/')}: ${first?.message ?? 'schema violation'}`);
  }
  const spec = verdict.value;
  if (spec.sideEffect === 'read_only') {
    if (spec.effect !== undefined) throw new OperationSpecError(`${spec.name} is read-only and must not declare an effect`);
  } else {
    if (spec.effect === undefined) throw new OperationSpecError(`${spec.name} changes state and must declare exactly one effect`);
    if (spec.observe.length === 0) throw new OperationSpecError(`${spec.name} needs at least one probe`);
    if (spec.applied.length === 0) throw new OperationSpecError(`${spec.name} needs an applied clause, or every call would look applied`);
    if (spec.guard === undefined) throw new OperationSpecError(`${spec.name} needs a guard`);
  }
  if (spec.effect !== undefined) {
    const bound = boundInputs(spec.effect, spec.require ?? []);
    const unbound = subjectInputs(spec.subject).find((reference) => !bound.has(reference));
    if (unbound !== undefined) throw new OperationSpecError(`${spec.name}: the approval names ${unbound}, which is neither an argument of the effect nor required against an observation`);
  }
  const ids = spec.observe.map((probe) => probe.id);
  if (new Set(ids).size !== ids.length) throw new OperationSpecError(`${spec.name} declares a probe id twice`);
  return { ...spec, input: withRefNameRule(spec.input), require: spec.require ?? [] };
};

const resolveOperand = (operand: Operand, scope: Scope): string | undefined => (typeof operand === 'string' ? lookup(scope, operand) : operand.literal);

const holds = (clause: Clause, scope: Scope): boolean => {
  const left = resolveOperand(clause[0], scope);
  const right = resolveOperand(clause[1], scope);
  return left !== undefined && right !== undefined && left === right;
};

export const flattenClauses = (items: readonly ClauseItem[], scope: Scope): Clause[] =>
  items.flatMap((item): Clause[] => {
    if (Array.isArray(item)) return [item as Clause];
    const conditional = item as ConditionalClauses;
    return [...(isTruthy(scope, conditional.if) ? conditional.then : conditional.else)];
  });

export const evaluateClauses = (items: readonly ClauseItem[], scope: Scope): boolean => flattenClauses(items, scope).every((clause) => holds(clause, scope));

export const failedClauses = (items: readonly ClauseItem[], scope: Scope): Clause[] => flattenClauses(items, scope).filter((clause) => !holds(clause, scope));

export const describeClause = (clause: Clause, scope: Scope): string => {
  const side = (operand: Operand): string => {
    if (typeof operand !== 'string') return JSON.stringify(operand.literal);
    const value = lookup(scope, operand);
    return `${operand} (${value === undefined ? 'not observed' : JSON.stringify(value)})`;
  };
  return `${side(clause[0])} should equal ${side(clause[1])}`;
};

export type SupersededForm = { operation: string; argv: readonly string[] };

export const supersededForms = (specs: readonly OperationSpec[]): SupersededForm[] =>
  specs.flatMap((spec) => spec.supersedes.map((argv) => ({ operation: spec.name, argv })));
