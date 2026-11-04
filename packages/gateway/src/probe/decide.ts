import { MAX_BUDGET_COUNT, imageCapability } from '@momonga/protocol';
import type { Capabilities, CapabilitiesCore, ImageCapability, ProbeReport, ToolCallingMode } from '@momonga/protocol';

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
  if (contextWindow > MAX_BUDGET_COUNT) {
    throw new RangeError(`probed context window ${contextWindow} is above the exact budget domain of ${MAX_BUDGET_COUNT}`);
  }
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
    ...(report.promptCache === undefined ? {} : { promptCache: report.promptCache }),
    schemaDialect: 'json-schema-2020-12',
    tokenCounting: report.tokenCalibration === undefined ? 'estimated' : 'calibrated',
    ...(report.tokenCalibration === undefined ? {} : { tokenErrorRatio: report.tokenCalibration.errorBound }),
    usageReported: report.usageReported,
    maxConcurrency: report.maxConcurrency,
    source: 'probed',
    probedAt: report.probedAt,
  };
};

export type CapabilityLayer = Partial<CapabilitiesCore> & { image?: ImageCapability };

export type DeclaredCapabilities = CapabilitiesCore & (ImageCapability | { imageInput?: undefined; imageTokens?: undefined });

export const layerOf = (declared: DeclaredCapabilities): { core: CapabilitiesCore; layer: CapabilityLayer } => {
  const { imageInput, imageTokens, ...core } = declared;
  return { core, layer: { ...core, ...(imageInput === undefined ? {} : { image: imageCapability(imageInput, imageTokens) }) } };
};

export const withImageDefault = (declared: DeclaredCapabilities): Capabilities => {
  const { core, layer } = layerOf(declared);
  return { ...core, ...(layer.image ?? imageCapability(false, undefined)) };
};

const splitByPrecedence = (layer: CapabilityLayer) => {
  const { toolCalling, structuredOutput, streaming, stopSequences, parallelToolCalls, usageReported, reasoning, ...declaredFirst } = layer;
  return {
    declaredFirst,
    probeFirst: {
      ...(toolCalling === undefined ? {} : { toolCalling }),
      ...(structuredOutput === undefined ? {} : { structuredOutput }),
      ...(streaming === undefined ? {} : { streaming }),
      ...(stopSequences === undefined ? {} : { stopSequences }),
      ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
      ...(usageReported === undefined ? {} : { usageReported }),
      ...(reasoning === undefined ? {} : { reasoning }),
    },
  };
};

export type CapabilityMerge = {
  defaults: CapabilitiesCore;
  declared: CapabilityLayer;
  probed: CapabilityLayer;
  probedAt: string;
};

export const mergeCapabilities = ({ defaults, declared, probed, probedAt }: CapabilityMerge): Capabilities => {
  const fromDeclaration = splitByPrecedence(declared);
  const fromProbe = splitByPrecedence(probed);
  const { image, ...merged } = {
    ...defaults,
    ...fromProbe.declaredFirst,
    ...fromDeclaration.probeFirst,
    ...fromProbe.probeFirst,
    ...fromDeclaration.declaredFirst,
  };
  return { ...merged, ...(image ?? imageCapability(false, undefined)), source: 'probed', probedAt };
};
