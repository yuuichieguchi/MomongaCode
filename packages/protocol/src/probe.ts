import type { HealthResult, ImageTokenModel, OutputBoundField, ReasoningCapability } from './capabilities.ts';
import type { ConstructSupport } from './dialect.ts';

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

export type ProbeDialectResult = 'accepted' | 'refused' | 'not-enforced' | 'unrenderable';

export type ProbeDialectAttempt = { id: string; result: ProbeDialectResult; detail?: string };

export type ProbeReportDialect = { selected: string | null; shape: 'union' | 'flat' | null; tried: ProbeDialectAttempt[] };

export const JSON_MODE_PROBE_STATES = ['accepted', 'refused', 'unmeasured'] as const;

export type JsonModeProbeState = (typeof JSON_MODE_PROBE_STATES)[number];

export type ProbeReport = {
  probedAt: string;
  health: HealthResult;
  modelId: string;
  contextWindow: { value: number; method: 'reported' | 'searched'; overflowErrorShape?: unknown };
  streaming: { supported: boolean; doneSentinel: boolean; usageInStream: boolean };
  usageReported: boolean;
  nativeTools: { accepted: boolean; validRate: number; roundTripOk: boolean };
  constrained: { accepted: boolean; validRate: number };
  keywordSupport?: Record<ProbeKeyword, boolean>;
  constructSupport?: ConstructSupport;
  schemaDialect: ProbeReportDialect;
  stopSequences: boolean;
  outputBoundField?: OutputBoundField | 'none';
  parallelToolCalls?: { accepted: boolean; multiCallRate: number };
  reasoning?: Exclude<ReasoningCapability, { control: 'thinking' }>;
  maxConcurrency: number;
  imageInputAccepted: boolean;
  imageTokens?: ImageTokenModel;
  guardrail: { errorShape?: unknown };
  tokenCalibration?: { ratio: number; errorBound: number };
  promptCache?: { kind: 'automatic' | 'none' };
  jsonMode?: JsonModeProbeState;
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
  schemaDialect: ProbeReportDialect;
  promptCache?: { kind: 'automatic' | 'none' };
  jsonMode?: JsonModeProbeState;
  reasoning?: undefined;
};

export type EndpointProbeReport = ProbeReport | OllamaProbeReport;
