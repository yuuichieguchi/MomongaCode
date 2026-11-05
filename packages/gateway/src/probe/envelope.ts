import type { ProbeKeyword } from '@momonga/protocol';
import { resolvedOf, withKeywordSupport } from '../dialect/choice.ts';
import type { DialectChoice } from '../dialect/choice.ts';
import type { RenderLedger } from '../dialect/ledger.ts';
import type { KeywordSupport } from '../dialect/keyword-support.ts';
import { renderSchema } from '../dialect/render.ts';
import { renderToolParameters } from '../dialect/tool-render.ts';
import type { JsonObject } from './json.ts';

export type EnvelopeShape = 'union' | 'flat';

export interface ProbeTool {
  name: string;
  parameters?: JsonObject | null | undefined;
}

const literal = (value: string, support: KeywordSupport): JsonObject => {
  if (support.const) return { const: value };
  if (support.enum) return { enum: [value] };
  return { type: 'string' };
};

const argumentsOf = (tool: ProbeTool, support: KeywordSupport, dialect: DialectChoice, ledger: RenderLedger | undefined): unknown => {
  if (!support.nested) return { type: 'object' };
  return renderToolParameters(tool, withKeywordSupport(dialect, support), ledger).schema ?? { type: 'object' };
};

const callSchema = (tool: ProbeTool, support: KeywordSupport, dialect: DialectChoice, ledger: RenderLedger | undefined): JsonObject => ({
  type: 'object',
  properties: { name: literal(tool.name, support), arguments: argumentsOf(tool, support, dialect, ledger) },
  required: ['name', 'arguments'],
});

const envelopeAround = (calls: JsonObject, support: KeywordSupport, requireToolCalls: boolean, shape: EnvelopeShape): JsonObject => {
  if (requireToolCalls) {
    return {
      type: 'object',
      properties: { kind: literal('tool_calls', support), calls },
      required: ['kind', 'calls'],
    };
  }
  if (shape === 'flat') {
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

const callItemsFor = (
  tools: readonly ProbeTool[],
  support: KeywordSupport,
  shape: EnvelopeShape,
  dialect: DialectChoice,
  ledger: RenderLedger | undefined,
): JsonObject => {
  const [only] = tools;
  if (tools.length === 1 && only !== undefined) return callSchema(only, support, dialect, ledger);
  if (shape === 'union' && support.anyOf) return { anyOf: tools.map((tool) => callSchema(tool, support, dialect, ledger)) };
  const names = tools.map((tool) => tool.name);
  return {
    type: 'object',
    properties: { name: support.enum ? { enum: names } : { type: 'string' }, arguments: { type: 'object' } },
    required: ['name', 'arguments'],
  };
};

export const buildToolsEnvelope = (
  tools: readonly ProbeTool[],
  support: KeywordSupport,
  requireToolCalls: boolean,
  dialect: DialectChoice,
  shape: EnvelopeShape,
  ledger?: RenderLedger,
): JsonObject => {
  if (tools.length === 0) throw new RangeError('buildToolsEnvelope: at least one tool is required');
  const assembled = envelopeAround({ type: 'array', minItems: 1, items: callItemsFor(tools, support, shape, dialect, ledger) }, support, requireToolCalls, shape);
  return renderSchema(assembled, { kind: 'response-format' }, resolvedOf(dialect)).schema as JsonObject;
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
