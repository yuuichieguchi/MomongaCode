import type { Capabilities, HealthResult } from './capabilities.ts';
import type { CountTokensRequest, CountTokensResult } from './gateway-api.ts';
import type { ErrorBody, FunctionTool, InputItem, StreamEvent, ToolChoice, Usage } from './open-responses.ts';

export const ADAPTER_NEUTRAL_ERROR_CODES = ['guardrail_violation', 'content_filter', 'refusal'] as const;

export type AdapterNeutralErrorCode = (typeof ADAPTER_NEUTRAL_ERROR_CODES)[number];

export type AdapterTarget = { name: string; model: string };

export type DecodedCompactionItem = { type: 'compaction_summary'; summary: string };

export type AdapterInputItem = Exclude<InputItem, { type: 'compaction' }> | DecodedCompactionItem;

export type AdapterRequest = {
  model: string;
  input: AdapterInputItem[];
  instructions?: string | null;
  tools?: FunctionTool[];
  tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean;
  max_output_tokens?: number | null;
  temperature?: number | null;
  top_p?: number | null;
};

export type AdapterContext = {
  signal: AbortSignal;
  target: AdapterTarget;
  attempt: number;
};

export type ClassifiedError = {
  retryable: boolean;
  retryAfterMs?: number;
  error: ErrorBody;
};

export type AdapterCountTokensResult = CountTokensResult;

export type AdapterCompactRequest = {
  model: string;
  input: AdapterInputItem[];
  instructions?: string | null;
};

export type AdapterCompactResult = { summary: string; usage: Usage };

export type ProviderAdapter = {
  readonly kind: string;
  capabilities(target: AdapterTarget): Promise<Capabilities>;
  create(request: AdapterRequest, ctx: AdapterContext): AsyncIterable<StreamEvent>;
  classify(error: unknown): ClassifiedError;
  health?(target: AdapterTarget): Promise<HealthResult>;
  close?(): Promise<void>;
  countTokens?(request: CountTokensRequest, ctx: AdapterContext): Promise<AdapterCountTokensResult>;
  compact?(request: AdapterCompactRequest, ctx: AdapterContext): Promise<AdapterCompactResult>;
};
