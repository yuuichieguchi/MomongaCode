import type { ProbeKeyword } from '@momonga/protocol';
import { isRecord, type JsonObject } from './json.ts';

export type KeywordSupport = Record<ProbeKeyword, boolean>;

export const FULL_KEYWORD_SUPPORT: KeywordSupport = {
  enum: true,
  anyOf: true,
  const: true,
  pattern: true,
  minimum: true,
  nested: true,
  additionalProperties: true,
};

const literalTypeOf = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (Array.isArray(value)) return 'array';
  return 'object';
};

export const typeFromLiterals = (values: readonly unknown[]): string | string[] => {
  const types = new Set(values.map(literalTypeOf));
  if (types.has('integer') && types.has('number')) types.delete('integer');
  const unique = [...types];
  return unique.length === 1 ? (unique[0] as string) : unique;
};

const hasProperties = (node: unknown): boolean => isRecord(node) && isRecord(node['properties']);

const lowerChild = (node: unknown, support: KeywordSupport): unknown =>
  !support.nested && hasProperties(node) ? { type: 'object' } : lowerNode(node, support);

const lowerChildren = (node: unknown, support: KeywordSupport): unknown =>
  Array.isArray(node) ? node.map((entry) => lowerChild(entry, support)) : lowerNode(node, support);

const lowerNode = (node: unknown, support: KeywordSupport): unknown => {
  if (Array.isArray(node)) return node.map((entry) => lowerNode(entry, support));
  if (!isRecord(node)) return node;
  const lowered: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'pattern' && !support.pattern) continue;
    if (key === 'minimum' && !support.minimum) continue;
    if (key === 'additionalProperties' && !support.additionalProperties) continue;
    if (key === 'anyOf' && !support.anyOf) continue;
    if (key === 'enum' || key === 'const') {
      lowered[key] = value;
    } else if (key === 'properties' && isRecord(value)) {
      lowered[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, lowerChild(child, support)]),
      );
    } else if (key === 'items' || key === 'additionalProperties') {
      lowered[key] = lowerChild(value, support);
    } else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      lowered[key] = lowerChildren(value, support);
    } else {
      lowered[key] = lowerNode(value, support);
    }
  }
  if (!support.enum && 'enum' in lowered) {
    const values = lowered['enum'];
    delete lowered['enum'];
    lowered['type'] ??= typeFromLiterals(Array.isArray(values) ? values : []);
  }
  if (!support.const && 'const' in lowered) {
    const value = lowered['const'];
    delete lowered['const'];
    lowered['type'] ??= typeFromLiterals([value]);
  }
  return lowered;
};

export const lowerSchema = (schema: JsonObject, support: KeywordSupport): JsonObject => {
  const lowered = lowerNode(schema, support);
  return isRecord(lowered) ? lowered : {};
};
