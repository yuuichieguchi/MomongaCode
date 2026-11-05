import type { ProbeKeyword } from '@momonga/protocol';
import type { JsonObject } from './json.ts';
import { FULL_KEYWORD_SUPPORT, lowerSchema, type KeywordSupport } from './lowering.ts';
import { renderAssembled, supportIn, type SchemaDialect } from './schema-dialect.ts';

export { FULL_KEYWORD_SUPPORT, lowerSchema, type KeywordSupport };

export interface ProbeTool {
  name: string;
  parameters: JsonObject;
}

const literal = (value: string, support: KeywordSupport): JsonObject => {
  if (support.const) return { const: value };
  if (support.enum) return { enum: [value] };
  return { type: 'string' };
};

const callSchema = (tool: ProbeTool, support: KeywordSupport): JsonObject => ({
  type: 'object',
  properties: {
    name: literal(tool.name, support),
    arguments: support.nested ? lowerSchema(tool.parameters, support) : { type: 'object' },
  },
  required: ['name', 'arguments'],
});

const envelopeAround = (calls: JsonObject, support: KeywordSupport, requireToolCalls: boolean): JsonObject => {
  if (requireToolCalls) {
    return {
      type: 'object',
      properties: { kind: literal('tool_calls', support), calls },
      required: ['kind', 'calls'],
    };
  }
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

export const buildToolCallEnvelope = (tool: ProbeTool, measured: KeywordSupport, dialect: SchemaDialect): JsonObject => {
  const support = supportIn(dialect, measured);
  return renderAssembled(
    envelopeAround({ type: 'array', minItems: 1, maxItems: 1, items: callSchema(tool, support) }, support, false),
    dialect,
  );
};

const callItemsFor = (tools: readonly ProbeTool[], support: KeywordSupport): JsonObject => {
  const [only] = tools;
  if (tools.length === 1 && only !== undefined) return callSchema(only, support);
  if (support.anyOf) return { anyOf: tools.map((tool) => callSchema(tool, support)) };
  const names = tools.map((tool) => tool.name);
  return {
    type: 'object',
    properties: { name: support.enum ? { enum: names } : { type: 'string' }, arguments: { type: 'object' } },
    required: ['name', 'arguments'],
  };
};

export const buildToolsEnvelope = (
  tools: readonly ProbeTool[],
  measured: KeywordSupport,
  requireToolCalls: boolean,
  dialect: SchemaDialect,
): JsonObject => {
  if (tools.length === 0) throw new RangeError('buildToolsEnvelope: at least one tool is required');
  const support = supportIn(dialect, measured);
  return renderAssembled(
    envelopeAround({ type: 'array', minItems: 1, items: callItemsFor(tools, support) }, support, requireToolCalls),
    dialect,
  );
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
