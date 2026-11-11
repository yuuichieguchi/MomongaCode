import { describe, expect, it } from 'vitest';
import { capabilitiesFromProbe, decideToolCalling } from '@momonga/gateway';
import type { ToolCallingMode } from '@momonga/protocol';
import { makeReport } from './report-fixture.ts';

describe('decideToolCalling with default thresholds', () => {
  it.each<[number, number, ToolCallingMode]>([
    [1.0, 1.0, 'native'],
    [0.9, 0.9, 'native'],
    [0.9, 0.95, 'native'],
    [0.9, 1.0, 'constrained'],
    [0.95, 1.0, 'native'],
    [0.85, 0.95, 'constrained'],
    [0.85, 0.9, 'constrained'],
    [0.85, 0.85, 'none'],
    [0.5, 0.5, 'none'],
    [1.0, 0, 'native'],
    [0, 0.9, 'constrained'],
    [0, 0, 'none'],
    [0.8, 1.0, 'constrained'],
  ])('native %f, constrained %f -> %s', (nativeRate, constrainedRate, mode) => {
    expect(decideToolCalling(makeReport(nativeRate, constrainedRate))).toEqual({ mode });
  });

  it('never chooses native when native tools were not accepted', () => {
    const report = makeReport(0, 0.95);
    report.nativeTools = { accepted: false, validRate: 0, roundTripOk: false };
    expect(decideToolCalling(report)).toEqual({ mode: 'constrained' });
  });
});

describe('decideToolCalling with custom thresholds', () => {
  it('uses minValidRate and nativeMargin', () => {
    expect(decideToolCalling(makeReport(0.8, 0.9), { minValidRate: 0.8, nativeMargin: 0.1 })).toEqual({ mode: 'native' });
    expect(decideToolCalling(makeReport(0.8, 0.95), { minValidRate: 0.8, nativeMargin: 0.1 })).toEqual({ mode: 'constrained' });
    expect(decideToolCalling(makeReport(0.7, 0.75), { minValidRate: 0.8, nativeMargin: 0.1 })).toEqual({ mode: 'none' });
  });
});

describe('capabilitiesFromProbe', () => {
  it('maps the report and decision onto probed capabilities', () => {
    const report = makeReport(1, 1);
    report.stopSequences = true;
    report.imageInputAccepted = true;
    report.imageTokens = { pixelsPerToken: 700, maxTokens: 1500, minTokens: 1 };
    report.maxConcurrency = { value: 2, evidence: 'refused' };
    report.parallelToolCalls = { accepted: true, multiCallRate: 0 };
    report.streaming = { supported: true, doneSentinel: true, usageInStream: true };
    const capabilities = capabilitiesFromProbe(report, { mode: 'native' });
    expect(capabilities).toMatchObject({
      contextWindow: 4096,
      toolCalling: 'native',
      structuredOutput: 'json_schema',
      streaming: true,
      stopSequences: true,
      imageInput: true,
      imageTokens: { pixelsPerToken: 700, maxTokens: 1500, minTokens: 1 },
      parallelToolCalls: false,
      schemaDialect: 'json-schema-2020-12',
      tokenCounting: 'calibrated',
      usageReported: true,
      maxConcurrency: 2,
      source: 'probed',
      probedAt: '2026-10-23T00:00:00.000Z',
    });
    expect(capabilities.maxOutputTokens).toBeGreaterThan(0);
    expect(capabilities.maxOutputTokens).toBeLessThanOrEqual(4096);
  });

  it('runs a model whose max concurrency was not measured one request at a time', () => {
    const unmeasured = makeReport(1, 1);
    delete unmeasured.maxConcurrency;
    expect(capabilitiesFromProbe(unmeasured, { mode: 'native' }).maxConcurrency).toBe(1);
  });

  it('leaves parallel tool calls unknown when the probe measured nothing or the server refused the setting', () => {
    const unmeasured = makeReport(1, 1);
    expect('parallelToolCalls' in capabilitiesFromProbe(unmeasured, { mode: 'native' })).toBe(false);
    const refused = makeReport(1, 1);
    refused.parallelToolCalls = { accepted: false, multiCallRate: 0 };
    expect('parallelToolCalls' in capabilitiesFromProbe(refused, { mode: 'native' })).toBe(false);
  });

  it('refuses image input when the probe accepted an image but measured no token model', () => {
    const report = makeReport(1, 1);
    report.imageInputAccepted = true;
    const capabilities = capabilitiesFromProbe(report, { mode: 'native' });
    expect(capabilities.imageInput).toBe(false);
    expect(capabilities.imageTokens).toBeUndefined();
  });

  it('reflects missing structured output, streaming, usage and calibration', () => {
    const report = makeReport(0, 0);
    report.constrained = { accepted: false, validRate: 0 };
    report.streaming = { supported: false, doneSentinel: false, usageInStream: false };
    report.usageReported = false;
    delete report.tokenCalibration;
    const capabilities = capabilitiesFromProbe(report, { mode: 'none' });
    expect(capabilities).toMatchObject({
      toolCalling: 'none',
      structuredOutput: 'none',
      streaming: false,
      usageReported: false,
      tokenCounting: 'estimated',
      source: 'probed',
    });
  });
});
