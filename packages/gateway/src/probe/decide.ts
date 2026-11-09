import { MAX_BUDGET_COUNT, imageCapability } from '@momonga/protocol';
import type { Capabilities, CapabilitiesCore, DialectId, ImageCapability, ProbeReport, ToolCallingMode } from '@momonga/protocol';
import { resolveDialectId } from '../dialect/resolve-id.ts';
import { jsonModeCapabilityOf } from './json-mode.ts';

export interface DecideThresholds {
  minValidRate?: number;
  nativeMargin?: number;
}

export interface ToolCallingDecision {
  mode: ToolCallingMode;
}

export const DEFAULT_MIN_VALID_RATE = 0.9;

const EPSILON = 1e-9;

export const atLeast = (value: number, threshold: number): boolean => value >= threshold - EPSILON;

export const decideToolCalling = (report: ProbeReport, thresholds: DecideThresholds = {}): ToolCallingDecision => {
  const minValidRate = thresholds.minValidRate ?? DEFAULT_MIN_VALID_RATE;
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
  return { parallelToolCalls: atLeast(parallel.multiCallRate, thresholds.minValidRate ?? DEFAULT_MIN_VALID_RATE) };
};

export const maxOutputTokensFor = (contextWindow: number): number => Math.min(contextWindow, Math.max(256, Math.ceil(contextWindow / 4)));

export type ProbeOutputPolicy = { unboundedOutputReserve: boolean };

const OUTPUT_POLICY_OFF: ProbeOutputPolicy = { unboundedOutputReserve: false };

const probedOutputBound = (report: ProbeReport, policy: ProbeOutputPolicy): Pick<Capabilities, 'outputBoundField'> => {
  if (report.outputBoundField === undefined) return {};
  if (report.outputBoundField === 'none' && !policy.unboundedOutputReserve) return {};
  return { outputBoundField: report.outputBoundField };
};

export const capabilitiesFromProbe = (
  report: ProbeReport,
  decision: ToolCallingDecision,
  thresholds: DecideThresholds = {},
  policy: ProbeOutputPolicy = OUTPUT_POLICY_OFF,
): Capabilities => {
  const contextWindow = report.contextWindow.value;
  if (contextWindow > MAX_BUDGET_COUNT) {
    throw new RangeError(`probed context window ${contextWindow} is above the exact budget domain of ${MAX_BUDGET_COUNT}`);
  }
  return {
    contextWindow,
    maxOutputTokens: maxOutputTokensFor(contextWindow),
    toolCalling: decision.mode,
    structuredOutput: report.constrained.accepted ? 'json_schema' : 'none',
    ...jsonModeCapabilityOf(report.jsonMode),
    streaming: report.streaming.supported,
    stopSequences: report.stopSequences,
    ...probedOutputBound(report, policy),
    ...probedImageCapability(report),
    ...parallelCallsDecision(report, thresholds),
    ...(report.reasoning === undefined ? {} : { reasoning: report.reasoning }),
    ...(report.promptCache === undefined ? {} : { promptCache: report.promptCache }),
    schemaDialect: resolveDialectId(undefined, report),
    tokenCounting: report.tokenCalibration === undefined ? 'estimated' : 'calibrated',
    ...(report.tokenCalibration === undefined ? {} : { tokenErrorRatio: report.tokenCalibration.errorBound }),
    usageReported: report.usageReported,
    maxConcurrency: report.maxConcurrency,
    source: 'probed',
    probedAt: report.probedAt,
  };
};

export type CapabilityLayer = Partial<CapabilitiesCore> & { image?: ImageCapability };

export type DeclaredCore = Omit<CapabilitiesCore, 'schemaDialect'> & { schemaDialect?: DialectId };

export type DeclaredCapabilities = DeclaredCore & (ImageCapability | { imageInput?: undefined; imageTokens?: undefined });

export const layerOf = <Declared extends DeclaredCapabilities>(declared: Declared): { core: Omit<Declared, 'imageInput' | 'imageTokens'>; layer: CapabilityLayer } => {
  const { imageInput, imageTokens, ...core } = declared;
  const { imageInput: _input, imageTokens: _tokens, ...base }: DeclaredCapabilities = declared;
  return { core, layer: { ...base, ...(imageInput === undefined ? {} : { image: imageCapability(imageInput, imageTokens) }) } };
};

export const withImageDefault = (declared: DeclaredCapabilities, record: Pick<ProbeReport, 'schemaDialect'> | null = null): Capabilities => {
  const { core, layer } = layerOf(declared);
  return { ...core, schemaDialect: resolveDialectId(core.schemaDialect, record), ...(layer.image ?? imageCapability(false, undefined)) };
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
