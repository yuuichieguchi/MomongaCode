import type { DialectClause, DialectKind } from '@momonga/protocol';
import { isRecord, typeIncludes } from './schema.ts';
import type { JsonObject } from './schema.ts';
import type { NodeContext, RenderState } from './state.ts';

const PROPERTY_DECLARING_APPLICATORS = ['anyOf', 'allOf', 'oneOf', '$ref', '$dynamicRef', 'if', 'then', 'else', 'dependentSchemas'] as const;

type KindTest = (node: JsonObject, context: NodeContext, state: RenderState) => boolean;

const KIND_TESTS: Record<DialectKind, KindTest> = {
  any: () => true,
  root: (_node, context, state) => context.isRoot && state.site.kind !== 'tool-parameters',
  'tool-parameters': (_node, context, state) => context.isRoot && state.site.kind === 'tool-parameters',
  'object-with-properties': (node) => isRecord(node['properties']),
  'object-without-properties': (node) => typeIncludes(node, 'object') && !isRecord(node['properties']) && !PROPERTY_DECLARING_APPLICATORS.some((keyword) => keyword in node),
  'any-of': (node) => Array.isArray(node['anyOf']),
  'any-of-branch': (_node, context) => context.via === 'anyOf',
  enum: (node) => Array.isArray(node['enum']),
  const: (node) => 'const' in node,
  untyped: (node) => !('type' in node) && !('const' in node) && !('$ref' in node) && !('anyOf' in node),
  array: (node) => typeIncludes(node, 'array') || 'items' in node,
  'type-string': (node) => typeIncludes(node, 'string'),
  'type-number': (node) => typeIncludes(node, 'number'),
  'type-integer': (node) => typeIncludes(node, 'integer'),
  'type-boolean': (node) => typeIncludes(node, 'boolean'),
  'type-null': (node) => typeIncludes(node, 'null'),
};

const withinMatches = (steps: readonly string[], below: readonly string[], through: readonly string[]): boolean =>
  steps.some((step, index) => below.includes(step) && steps.slice(index + 1).every((later) => through.includes(later)));

export const clauseMatches = (clause: DialectClause, node: JsonObject, context: NodeContext, state: RenderState): boolean =>
  clause.kinds.every((kind) => KIND_TESTS[kind](node, context, state)) &&
  (clause.within === undefined || withinMatches(context.steps, clause.within.below, clause.within.through));
