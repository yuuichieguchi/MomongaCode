import type { Clock } from '@momonga/foundation';
import type {
  AdapterSampling,
  AdapterTarget,
  Capabilities,
  ConstructSupport,
  DialectId,
  CountTokensRequest,
  CountTokensResult,
  HealthResult,
  ProviderAdapter,
} from '@momonga/protocol';
import type { UpstreamEndpoint, UpstreamLiveness } from '../shared/http-client.ts';
import type { UserDialects } from '../../dialect/choice.ts';
import type { KeywordSupport } from '../../dialect/keyword-support.ts';
import type { EnvelopeShape } from '../../probe/envelope.ts';
import type { ErrorVocabulary } from '../shared/vocabulary.ts';

export type ChatCompletionsEndpoint = UpstreamEndpoint;

export type ChatCompletionsAdapterOptions = {
  resolveEndpoint: (target: AdapterTarget, signal: AbortSignal) => Promise<ChatCompletionsEndpoint>;
  sampling?: AdapterSampling;
  upstreamModel?: (target: AdapterTarget, signal: AbortSignal) => Promise<string>;
  onSummaryReasoning?: (target: AdapterTarget, hiddenReasoningTokens: number) => Promise<void>;
  keywordSupport?: (target: AdapterTarget) => KeywordSupport;
  schemaDialect: (target: AdapterTarget) => DialectId;
  constructSupport?: (target: AdapterTarget) => ConstructSupport | undefined;
  envelopeShape?: (target: AdapterTarget) => EnvelopeShape;
  userDialects?: UserDialects;
  apiKey?: (target: AdapterTarget, signal: AbortSignal) => string | undefined | Promise<string | undefined>;
  countTokens?: (target: AdapterTarget, request: CountTokensRequest, signal: AbortSignal) => Promise<CountTokensResult>;
  capabilities: (target: AdapterTarget) => Promise<Capabilities>;
  health?: (target: AdapterTarget) => Promise<HealthResult>;
  vocabulary?: ErrorVocabulary;
  isGuardrail?: (target: AdapterTarget, status: number, body: unknown) => boolean;
  close?: () => Promise<void>;
  clock: Clock;
  liveness: UpstreamLiveness;
};

export type ChatCompletionsAdapter = ProviderAdapter & { close(): Promise<void> };
