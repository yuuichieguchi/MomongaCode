import Ajv2020 from 'ajv/dist/2020.js';
import type { JSONSchemaType } from 'ajv';
import { REASONING_EFFORTS } from '@momonga/protocol';
import type { EndpointProbeReport, OllamaProbeReport, ProbeReport } from '@momonga/protocol';

const bool = { type: 'boolean' } as const;
const anyJson = {} as never;
const rate = { type: 'number', minimum: 0, maximum: 1 } as const;

const reportSchema: JSONSchemaType<ProbeReport> = {
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
    'keywordSupport',
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
        reason: { type: 'string', enum: ['not_running', 'unhealthy', 'precondition_failed'], nullable: true },
        detail: { type: 'string', nullable: true },
        remediation: { type: 'string', nullable: true },
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
    stopSequences: bool,
    parallelToolCalls: {
      type: 'object',
      nullable: true,
      required: ['accepted', 'multiCallRate'],
      properties: { accepted: bool, multiCallRate: rate },
    },
    reasoning: anyJson,
    maxConcurrency: { type: 'integer', minimum: 1 },
    imageInputAccepted: bool,
    imageTokens: {
      type: 'object',
      nullable: true,
      required: ['pixelsPerToken', 'maxTokens', 'minTokens'],
      properties: {
        pixelsPerToken: { type: 'number', exclusiveMinimum: 0 },
        maxTokens: { type: 'integer', minimum: 1 },
        minTokens: { type: 'integer', minimum: 1 },
      },
    },
    guardrail: { type: 'object', required: [], properties: { errorShape: anyJson } },
    promptCache: {
      type: 'object',
      nullable: true,
      required: ['kind'],
      properties: { kind: { type: 'string', enum: ['automatic', 'none'] } },
      additionalProperties: false,
    },
    tokenCalibration: {
      type: 'object',
      nullable: true,
      required: ['ratio', 'errorBound'],
      properties: { ratio: { type: 'number' }, errorBound: { type: 'number', minimum: 0 } },
    },
  },
};

const validate = new Ajv2020.default({ strict: false }).compile(reportSchema);

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
};

const validateReasoning = new Ajv2020.default({ strict: false }).compile(reasoningSchema);

export const isProbeReport = (value: unknown): value is ProbeReport =>
  validate(value) && ((value as ProbeReport).reasoning === undefined || validateReasoning((value as ProbeReport).reasoning));

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
  required: ['kind', 'probedAt', 'serverVersion', 'modelId', 'contextWindow', 'nativeTools', 'imageInputAccepted', 'thinkingSupported'],
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
    promptCache: {
      type: 'object',
      required: ['kind'],
      additionalProperties: false,
      properties: { kind: { type: 'string', enum: ['automatic', 'none'] } },
    },
  },
} as const;

const validateOllama = new Ajv2020.default({ strict: false }).compile(ollamaReportSchema);

export const isOllamaProbeReport = (value: unknown): value is OllamaProbeReport => validateOllama(value);

export const isEndpointProbeReport = (value: unknown): value is EndpointProbeReport => isOllamaProbeReport(value) || isProbeReport(value);
