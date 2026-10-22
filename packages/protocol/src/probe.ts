import type { HealthResult } from './capabilities.ts';

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
  maxConcurrency: number;
  imageInputAccepted: boolean;
  guardrail: { errorShape?: unknown };
  tokenCalibration?: { ratio: number; errorBound: number };
};
