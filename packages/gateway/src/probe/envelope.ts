import type { ProbeKeyword } from '@momonga/protocol';
import { isRecord, type JsonObject } from './json.ts';

export type KeywordSupport = Record<ProbeKeyword, boolean>;

export interface ProbeTool {
  name: string;
  parameters: JsonObject;
}

const literalTypeOf = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (Array.isArray(value)) return 'array';
  return 'object';
};

const typeFromLiterals = (values: readonly unknown[]): string | string[] => {
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

const literal = (value: string, support: KeywordSupport): JsonObject => {
  if (support.const) return { const: value };
  if (support.enum) return { enum: [value] };
  return { type: 'string' };
};

export const buildToolCallEnvelope = (tool: ProbeTool, support: KeywordSupport): JsonObject => {
  const argumentsSchema = support.nested ? lowerSchema(tool.parameters, support) : { type: 'object' };
  const call = {
    type: 'object',
    properties: { name: literal(tool.name, support), arguments: argumentsSchema },
    required: ['name', 'arguments'],
  };
  const calls = { type: 'array', minItems: 1, maxItems: 1, items: call };
  if (!support.anyOf) {
    return {
      type: 'object',
      properties: {
        kind: support.enum ? { enum: ['final', 'tool_calls'] } : { type: 'string' },
        text: { type: 'string' },
        calls,
      },
      required: ['kind'],
    };
  }
  return {
    type: 'object',
    anyOf: [
      {
        type: 'object',
        properties: { kind: literal('final', support), text: { type: 'string' } },
        required: ['kind', 'text'],
      },
      {
        type: 'object',
        properties: { kind: literal('tool_calls', support), calls },
        required: ['kind', 'calls'],
      },
    ],
  };
};

export const keywordProbeSchemas: Record<ProbeKeyword, JsonObject> = {
  enum: { type: 'object', properties: { value: { enum: ['alpha', 'beta'] } }, required: ['value'] },
  anyOf: {
    type: 'object',
    properties: { value: { anyOf: [{ type: 'string' }, { type: 'integer' }] } },
    required: ['value'],
  },
  const: { type: 'object', properties: { value: { const: 'alpha' } }, required: ['value'] },
  pattern: {
    type: 'object',
    properties: { value: { type: 'string', pattern: '^[a-z]+$' } },
    required: ['value'],
  },
  minimum: {
    type: 'object',
    properties: { value: { type: 'integer', minimum: 1 } },
    required: ['value'],
  },
  nested: {
    type: 'object',
    properties: {
      outer: { type: 'object', properties: { inner: { type: 'string' } }, required: ['inner'] },
    },
    required: ['outer'],
  },
  additionalProperties: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
};
