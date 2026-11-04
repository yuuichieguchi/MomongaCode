import type { HealthResult, ImageTokenModel, ReasoningCapability } from './capabilities.ts';

export const PROBE_KEYWORDS = [
  'enum',
  'anyOf',
  'const',
  'pattern',
  'minimum',
  'nested',
  'additionalProperties',
] as const;

export type ProbeKeyword = (typeof PROBE_KEYWORDS)[number];

export type ProbeReport = {
  probedAt: string;
  health: HealthResult;
  modelId: string;
  contextWindow: { value: number; method: 'reported' | 'searched'; overflowErrorShape?: unknown };
  streaming: { supported: boolean; doneSentinel: boolean; usageInStream: boolean };
  usageReported: boolean;
  nativeTools: { accepted: boolean; validRate: number; roundTripOk: boolean };
  constrained: { accepted: boolean; validRate: number };
  keywordSupport: Record<ProbeKeyword, boolean>;
  stopSequences: boolean;
  parallelToolCalls?: { accepted: boolean; multiCallRate: number };
  reasoning?: ReasoningCapability;
  maxConcurrency: number;
  imageInputAccepted: boolean;
  imageTokens?: ImageTokenModel;
  guardrail: { errorShape?: unknown };
  tokenCalibration?: { ratio: number; errorBound: number };
  promptCache?: { kind: 'automatic' | 'none' };
};

export type OllamaProbeReport = {
  kind: 'ollama';
  probedAt: string;
  serverVersion: string;
  modelId: string;
  contextWindow: { value: number; method: 'reported' };
  nativeTools: { accepted: boolean };
  imageInputAccepted: boolean;
  imageTokens?: ImageTokenModel;
  thinkingSupported: boolean;
  promptCache?: { kind: 'automatic' | 'none' };
  reasoning?: undefined;
};

export type EndpointProbeReport = ProbeReport | OllamaProbeReport;
