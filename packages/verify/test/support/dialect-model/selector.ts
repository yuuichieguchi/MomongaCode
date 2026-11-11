import type { Clause, Kind } from './definition.ts';
import { isObject, type Schema } from './json.ts';

export type Site = 'response-format' | 'tool-parameters';

export interface Position {
  site: Site;
  edges: readonly string[];
}

const hasType = (node: Record<string, unknown>, type: string): boolean =>
  node['type'] === type || (Array.isArray(node['type']) && node['type'].includes(type));

const PROPERTY_DECLARING_APPLICATORS = ['anyOf', 'allOf', 'oneOf', '$ref', '$dynamicRef', 'if', 'then', 'else', 'dependentSchemas'] as const;

export const matchesKind = (kind: Kind, node: Schema, position: Position): boolean => {
  const atRoot = position.edges.length === 0;
  if (kind === 'any') return true;
  if (kind === 'root') return atRoot && position.site === 'response-format';
  if (kind === 'tool-parameters') return atRoot && position.site === 'tool-parameters';
  if (!isObject(node)) return false;
  switch (kind) {
    case 'object-with-properties':
      return isObject(node['properties']);
    case 'object-without-properties':
      return hasType(node, 'object') && !('properties' in node) && !PROPERTY_DECLARING_APPLICATORS.some((keyword) => keyword in node);
    case 'any-of':
      return 'anyOf' in node;
    case 'any-of-branch':
      return position.edges[position.edges.length - 1] === 'anyOf';
    case 'enum':
      return 'enum' in node;
    case 'const':
      return 'const' in node;
    case 'untyped':
      return !('type' in node) && !('const' in node) && !('$ref' in node) && !('anyOf' in node);
    case 'array':
      return hasType(node, 'array') || 'items' in node;
    case 'type-string':
      return hasType(node, 'string');
    case 'type-number':
      return hasType(node, 'number');
    case 'type-integer':
      return hasType(node, 'integer');
    case 'type-boolean':
      return hasType(node, 'boolean');
    case 'type-null':
      return hasType(node, 'null');
    default:
      return false;
  }
};

const withinHolds = (within: NonNullable<Clause['within']>, edges: readonly string[]): boolean => {
  for (let index = 0; index < edges.length; index += 1) {
    if (!within.below.includes(edges[index] as string)) continue;
    if (edges.slice(index + 1).every((edge) => within.through.includes(edge))) return true;
  }
  return false;
};

export const selects = (select: readonly Clause[], node: Schema, position: Position): boolean =>
  select.some(
    (clause) =>
      clause.kinds.every((kind) => matchesKind(kind, node, position)) &&
      (clause.within === undefined || withinHolds(clause.within, position.edges)),
  );
