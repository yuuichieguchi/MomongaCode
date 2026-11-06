import { defineProductSchema } from '@momonga/foundation';
import type { ProductValidator } from '@momonga/foundation';
import { OUTPUT_BOUND_FIELDS, REASONING_EFFORTS } from '@momonga/protocol';
import type { EndpointProbeReport, OllamaProbeReport, ProbeReport } from '@momonga/protocol';

const bool = { type: 'boolean' } as const;
const anyJson = {} as const;
const rate = { type: 'number', minimum: 0, maximum: 1 } as const;

const dialectReportSchema = {
  type: 'object',
  required: ['selected', 'shape', 'tried'],
  additionalProperties: false,
  properties: {
    selected: { type: ['string', 'null'], minLength: 1 },
    shape: { type: ['string', 'null'], enum: ['union', 'flat', null] },
    tried: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'result'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          result: { type: 'string', enum: ['accepted', 'refused', 'not-enforced', 'unrenderable'] },
          detail: { type: 'string' },
        },
      },
    },
  },
} as const;

const constructResult = { type: 'string', enum: ['accepted', 'refused', 'unrenderable'] } as const;

const reportSchema = {
  type: 'object',
  required: [
    'probedAt',
    'health',
    'modelId',
    'contextWindow',
    'streaming',
    'usageReported',
    'nativeTools',
    'constrained',
    'schemaDialect',
    'stopSequences',
    'maxConcurrency',
    'imageInputAccepted',
    'guardrail',
  ],
  properties: {
    probedAt: { type: 'string' },
    health: {
      type: 'object',
      required: ['ok'],
      properties: {
        ok: bool,
        reason: { type: ['string', 'null'], enum: ['not_running', 'unhealthy', 'precondition_failed'] },
        detail: { type: ['string', 'null'] },
        remediation: { type: ['string', 'null'] },
      },
    },
    modelId: { type: 'string' },
    contextWindow: {
      type: 'object',
      required: ['value', 'method'],
      properties: {
        value: { type: 'integer', minimum: 1 },
        method: { type: 'string', enum: ['reported', 'searched'] },
        overflowErrorShape: anyJson,
      },
    },
    streaming: {
      type: 'object',
      required: ['supported', 'doneSentinel', 'usageInStream'],
      properties: { supported: bool, doneSentinel: bool, usageInStream: bool },
    },
    usageReported: bool,
    nativeTools: {
      type: 'object',
      required: ['accepted', 'validRate', 'roundTripOk'],
      properties: { accepted: bool, validRate: rate, roundTripOk: bool },
    },
    constrained: {
      type: 'object',
      required: ['accepted', 'validRate'],
      properties: { accepted: bool, validRate: rate },
    },
    keywordSupport: {
      type: 'object',
      required: ['enum', 'anyOf', 'const', 'pattern', 'minimum', 'nested', 'additionalProperties'],
      properties: {
        enum: bool,
        anyOf: bool,
        const: bool,
        pattern: bool,
        minimum: bool,
        nested: bool,
        additionalProperties: bool,
      },
    },
    constructSupport: {
      type: 'object',
      required: ['ref', 'typeArray', 'mixedEnum'],
      additionalProperties: false,
      properties: { ref: constructResult, typeArray: constructResult, mixedEnum: constructResult },
    },
    schemaDialect: dialectReportSchema,
    stopSequences: bool,
    outputBoundField: { type: ['string', 'null'], enum: [...OUTPUT_BOUND_FIELDS, 'none'] },
    parallelToolCalls: {
      type: ['object', 'null'],
      required: ['accepted', 'multiCallRate'],
      properties: { accepted: bool, multiCallRate: rate },
    },
    reasoning: anyJson,
    maxConcurrency: { type: 'integer', minimum: 1 },
    imageInputAccepted: bool,
    imageTokens: {
      type: ['object', 'null'],
      required: ['pixelsPerToken', 'maxTokens', 'minTokens'],
      properties: {
        pixelsPerToken: { type: 'number', exclusiveMinimum: 0 },
        maxTokens: { type: 'integer', minimum: 1 },
        minTokens: { type: 'integer', minimum: 1 },
      },
    },
    guardrail: { type: 'object', required: [], properties: { errorShape: anyJson } },
    promptCache: {
      type: ['object', 'null'],
      required: ['kind'],
      properties: { kind: { type: 'string', enum: ['automatic', 'none'] } },
      additionalProperties: false,
    },
    tokenCalibration: {
      type: ['object', 'null'],
      required: ['ratio', 'errorBound'],
      properties: { ratio: { type: 'number' }, errorBound: { type: 'number', minimum: 0 } },
    },
  },
} as const;

const validateReport: ProductValidator<ProbeReport> = defineProductSchema('gateway/probe-report', reportSchema);

const reasoningSchema = {
  oneOf: [
    {
      type: 'object',
      properties: { control: { const: 'none' }, headroomTokens: { type: 'integer', minimum: 0 } },
      required: ['control'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { control: { const: 'reasoning_effort' }, lowest: { enum: [...REASONING_EFFORTS] } },
      required: ['control', 'lowest'],
      additionalProperties: false,
    },
  ],
} as const;

const validateReasoning: ProductValidator<unknown> = defineProductSchema('gateway/probe-reasoning', reasoningSchema);

export const isProbeReport = (value: unknown): value is ProbeReport => {
  const verdict = validateReport(value);
  return verdict.valid && (verdict.value.reasoning === undefined || validateReasoning(verdict.value.reasoning).valid);
};

const imageTokensSchema = {
  type: 'object',
  required: ['pixelsPerToken', 'maxTokens', 'minTokens'],
  additionalProperties: false,
  properties: {
    pixelsPerToken: { type: 'number', exclusiveMinimum: 0 },
    maxTokens: { type: 'integer', minimum: 1 },
    minTokens: { type: 'integer', minimum: 1 },
  },
} as const;

const ollamaReportSchema = {
  type: 'object',
  required: ['kind', 'probedAt', 'serverVersion', 'modelId', 'contextWindow', 'nativeTools', 'imageInputAccepted', 'thinkingSupported', 'schemaDialect'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'ollama' },
    probedAt: { type: 'string' },
    serverVersion: { type: 'string' },
    modelId: { type: 'string' },
    contextWindow: {
      type: 'object',
      required: ['value', 'method'],
      additionalProperties: false,
      properties: { value: { type: 'integer', minimum: 1 }, method: { type: 'string', const: 'reported' } },
    },
    nativeTools: { type: 'object', required: ['accepted'], additionalProperties: false, properties: { accepted: bool } },
    imageInputAccepted: bool,
    imageTokens: imageTokensSchema,
    thinkingSupported: bool,
    schemaDialect: dialectReportSchema,
    promptCache: {
      type: 'object',
      required: ['kind'],
      additionalProperties: false,
      properties: { kind: { type: 'string', enum: ['automatic', 'none'] } },
    },
  },
} as const;

const validateOllama: ProductValidator<OllamaProbeReport> = defineProductSchema('gateway/probe-ollama-report', ollamaReportSchema);

export const isOllamaProbeReport = (value: unknown): value is OllamaProbeReport => validateOllama(value).valid;

export const isEndpointProbeReport = (value: unknown): value is EndpointProbeReport => isOllamaProbeReport(value) || isProbeReport(value);
