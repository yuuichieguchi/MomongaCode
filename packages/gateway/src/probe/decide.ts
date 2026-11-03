import { imageCapability } from '@momonga/protocol';
import type { Capabilities, ImageCapability, ProbeReport, ToolCallingMode } from '@momonga/protocol';

export interface DecideThresholds {
  minValidRate?: number;
  nativeMargin?: number;
}

export interface ToolCallingDecision {
  mode: ToolCallingMode;
}

const EPSILON = 1e-9;

const atLeast = (value: number, threshold: number): boolean => value >= threshold - EPSILON;

export const decideToolCalling = (report: ProbeReport, thresholds: DecideThresholds = {}): ToolCallingDecision => {
  const minValidRate = thresholds.minValidRate ?? 0.9;
  const nativeMargin = thresholds.nativeMargin ?? 0.05;
  const native = report.nativeTools;
  const constrained = report.constrained;
  const constrainedRate = constrained.accepted ? constrained.validRate : 0;
  if (
    native.accepted &&
    atLeast(native.validRate, minValidRate) &&
    atLeast(native.validRate, constrainedRate - nativeMargin)
  ) {
    return { mode: 'native' };
  }
  if (constrained.accepted && atLeast(constrained.validRate, minValidRate)) return { mode: 'constrained' };
  return { mode: 'none' };
};

const probedImageCapability = (report: ProbeReport): ImageCapability =>
  report.imageInputAccepted && report.imageTokens !== undefined
    ? imageCapability(true, report.imageTokens)
    : imageCapability(false, undefined);

const parallelCallsDecision = (report: ProbeReport, thresholds: DecideThresholds): Pick<Capabilities, 'parallelToolCalls'> => {
  const parallel = report.parallelToolCalls;
  if (parallel === undefined || !parallel.accepted) return {};
  return { parallelToolCalls: atLeast(parallel.multiCallRate, thresholds.minValidRate ?? 0.9) };
};

export const maxOutputTokensFor = (contextWindow: number): number => Math.min(contextWindow, Math.max(256, Math.ceil(contextWindow / 4)));

export const capabilitiesFromProbe = (report: ProbeReport, decision: ToolCallingDecision, thresholds: DecideThresholds = {}): Capabilities => {
  const contextWindow = report.contextWindow.value;
  return {
    contextWindow,
    maxOutputTokens: maxOutputTokensFor(contextWindow),
    toolCalling: decision.mode,
    structuredOutput: report.constrained.accepted ? 'json_schema' : 'none',
    streaming: report.streaming.supported,
    stopSequences: report.stopSequences,
    ...probedImageCapability(report),
    ...parallelCallsDecision(report, thresholds),
    ...(report.reasoning === undefined ? {} : { reasoning: report.reasoning }),
    schemaDialect: 'json-schema-2020-12',
    tokenCounting: report.tokenCalibration === undefined ? 'estimated' : 'calibrated',
    ...(report.tokenCalibration === undefined ? {} : { tokenErrorRatio: report.tokenCalibration.errorBound }),
    usageReported: report.usageReported,
    maxConcurrency: report.maxConcurrency,
    source: 'probed',
    probedAt: report.probedAt,
  };
};
