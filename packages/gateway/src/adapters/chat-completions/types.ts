import type { Clock } from '@momonga/foundation';
import type {
  AdapterTarget,
  Capabilities,
  CountTokensRequest,
  CountTokensResult,
  HealthResult,
  ProviderAdapter,
  ToolCallingMode,
} from '@momonga/protocol';
import type { KeywordSupport } from '../../probe/envelope.ts';

export type ChatCompletionsEndpoint = { kind: 'unix'; socketPath: string } | { kind: 'tcp'; baseUrl: string };

export type ChatCompletionsAdapterOptions = {
  resolveEndpoint: (target: AdapterTarget) => Promise<ChatCompletionsEndpoint>;
  toolCalling: (target: AdapterTarget) => ToolCallingMode;
  keywordSupport?: (target: AdapterTarget) => KeywordSupport;
  apiKey?: (target: AdapterTarget) => string | undefined | Promise<string | undefined>;
  countTokens?: (target: AdapterTarget, request: CountTokensRequest, signal: AbortSignal) => Promise<CountTokensResult>;
  capabilities: (target: AdapterTarget) => Promise<Capabilities>;
  health?: (target: AdapterTarget) => Promise<HealthResult>;
  isGuardrail?: (target: AdapterTarget, status: number, body: unknown) => boolean;
  close?: () => Promise<void>;
  clock: Clock;
};

export type ChatCompletionsAdapter = ProviderAdapter & { close(): Promise<void> };
