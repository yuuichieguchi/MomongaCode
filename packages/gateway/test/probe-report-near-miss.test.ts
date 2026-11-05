import { describe, expect, it } from 'vitest';
import { isEndpointProbeReport, isOllamaProbeReport, isProbeReport } from '../src/probe/report-schema.ts';

const REPORT = {
  probedAt: '2026-10-23T00:00:00.000Z',
  health: { ok: true },
  modelId: 'system',
  contextWindow: { value: 4096, method: 'reported' },
  streaming: { supported: true, doneSentinel: true, usageInStream: false },
  usageReported: true,
  nativeTools: { accepted: true, validRate: 1, roundTripOk: true },
  constrained: { accepted: true, validRate: 0.5 },
  keywordSupport: { enum: true, anyOf: true, const: true, pattern: true, minimum: true, nested: true, additionalProperties: true },
  schemaDialect: { selected: 'json-schema-2020-12', shape: 'union', tried: [{ id: 'json-schema-2020-12', result: 'accepted' }] },
  stopSequences: true,
  maxConcurrency: 1,
  imageInputAccepted: false,
  guardrail: {},
};

const OLLAMA_REPORT = {
  kind: 'ollama',
  probedAt: '2026-10-23T00:00:00.000Z',
  serverVersion: '0.12.0',
  modelId: 'devstral-small-2',
  contextWindow: { value: 12288, method: 'reported' },
  nativeTools: { accepted: true },
  imageInputAccepted: false,
  thinkingSupported: false,
  schemaDialect: { selected: null, shape: null, tried: [] },
};

const without = (record: Record<string, unknown>, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

describe('probe report verdicts on near misses', () => {
  it('accepts the base reports', () => {
    expect(isProbeReport(REPORT)).toBe(true);
    expect(isOllamaProbeReport(OLLAMA_REPORT)).toBe(true);
    expect(isEndpointProbeReport(REPORT)).toBe(true);
    expect(isEndpointProbeReport(OLLAMA_REPORT)).toBe(true);
  });

  it.each([
    ['a null health reason, which its enum does not list', { ...REPORT, health: { ok: true, reason: null } }],
    ['a health reason outside its enum', { ...REPORT, health: { ok: false, reason: 'asleep' } }],
    ['a valid rate above 1', { ...REPORT, nativeTools: { accepted: true, validRate: 2, roundTripOk: true } }],
    ['a missing model id', without(REPORT, 'modelId')],
    ['a null output bound field, which its enum does not list', { ...REPORT, outputBoundField: null }],
    ['a context window of 0', { ...REPORT, contextWindow: { value: 0, method: 'reported' } }],
    ['an unknown prompt cache key', { ...REPORT, promptCache: { kind: 'none', extra: 1 } }],
    ['image tokens of zero pixels per token', { ...REPORT, imageTokens: { pixelsPerToken: 0, maxTokens: 1, minTokens: 1 } }],
    ['a reasoning control outside its variants', { ...REPORT, reasoning: { control: 'thinking_budget' } }],
    ['a null health detail where ok is missing', { ...REPORT, health: { detail: null } }],
  ])('rejects %s', (_label, report) => {
    expect(isProbeReport(report)).toBe(false);
  });

  it.each([
    ['a null health detail and remediation', { ...REPORT, health: { ok: false, reason: 'unhealthy', detail: null, remediation: null } }],
    ['a null parallel tool call record', { ...REPORT, parallelToolCalls: null }],
    ['a null prompt cache, image token and token calibration record', { ...REPORT, promptCache: null, imageTokens: null, tokenCalibration: null }],
    ['an output bound field from its enum', { ...REPORT, outputBoundField: 'max_tokens' }],
    ['no reasoning control with headroom', { ...REPORT, reasoning: { control: 'none', headroomTokens: 0 } }],
  ])('accepts %s', (_label, report) => {
    expect(isProbeReport(report)).toBe(true);
  });

  it.each([
    ['a searched context window', { ...OLLAMA_REPORT, contextWindow: { value: 12288, method: 'searched' } }],
    ['an unknown key', { ...OLLAMA_REPORT, extra: 1 }],
    ['a missing server version', without(OLLAMA_REPORT, 'serverVersion')],
    ['a null prompt cache', { ...OLLAMA_REPORT, promptCache: null }],
  ])('rejects an Ollama report with %s', (_label, report) => {
    expect(isOllamaProbeReport(report)).toBe(false);
  });
});
