import type { AdapterSampling, AllowedToolsForm, Capabilities, HealthResult, ReasoningEffort } from './capabilities.ts';
import type { CountTokensRequest, CountTokensResult } from './gateway-api.ts';
import type { CompactMomongaExtension, ErrorBody, FunctionTool, InputItem, PromptCacheCounts, ReasoningInputItem, StreamEvent, TextField, ToolChoice, Usage } from './open-responses.ts';

export const ADAPTER_NEUTRAL_ERROR_CODES = [
  'guardrail_violation',
  'content_filter',
  'refusal',
  'compaction_summary_too_long',
  'compaction_invalid_reply',
] as const;

export type AdapterNeutralErrorCode = (typeof ADAPTER_NEUTRAL_ERROR_CODES)[number];

export type AdapterTarget = { name: string; model: string };

export type DecodedCompactionItem = { type: 'compaction_summary'; summary: string };

export type AdapterInputItem = Exclude<InputItem, { type: 'compaction' }> | DecodedCompactionItem;

export type ReasoningOrigin = { own(item: ReasoningInputItem): ReasoningInputItem | undefined };

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
  frequency_penalty?: number | null;
  presence_penalty?: number | null;
  reasoning_effort?: ReasoningEffort;
  text?: TextField;
  promptCacheKey?: string;
  cacheMarks?: PromptCacheCounts;
  unknownFields?: Record<string, unknown>;
};

export type AdapterContext = {
  signal: AbortSignal;
  target: AdapterTarget;
  attempt: number;
  reasoningOrigin: ReasoningOrigin;
  capabilities: Capabilities;
};

export type ClassifiedError = {
  retryable: boolean;
  stalled?: true;
  retryAfterMs?: number;
  error: ErrorBody;
};

export type AdapterCountTokensResult = CountTokensResult;

export type AdapterCompactRequest = {
  model: string;
  input: AdapterInputItem[];
  instructions?: string | null;
  momonga?: CompactMomongaExtension;
};

export type LenientItems = { callNames: Record<string, string>; withTools: boolean };

export type ToolChoiceWire = { forms: readonly AllowedToolsForm[]; expressesRequired: boolean };

export type RenderWireOptions = { reasoningOrigin: ReasoningOrigin; capabilities: Capabilities; lenientItems?: LenientItems };

export type AdapterCompactResult = { summary: string; usage: Usage; cacheWriteInputTokens?: number };

export type ClientOperation = 'create' | 'compact' | 'count_tokens';

export type AdapterStop = { readonly managedServerStopGraceMs: number };

export type ProviderAdapter = {
  readonly kind: string;
  readonly sampling: AdapterSampling;
  readonly relaysClientBody: readonly ClientOperation[];
  capabilities(target: AdapterTarget): Promise<Capabilities>;
  create(request: AdapterRequest, ctx: AdapterContext): AsyncIterable<StreamEvent>;
  classify(error: unknown): ClassifiedError;
  health?(target: AdapterTarget): Promise<HealthResult>;
  close?(stop?: AdapterStop): Promise<void>;
  countTokens?(request: CountTokensRequest, ctx: AdapterContext): Promise<AdapterCountTokensResult>;
  countWire?(wire: Record<string, unknown>, ctx: AdapterContext): Promise<AdapterCountTokensResult>;
  compact?(request: AdapterCompactRequest, ctx: AdapterContext): Promise<AdapterCompactResult>;
  renderCompactWire?(request: AdapterCompactRequest, target: AdapterTarget, cap: number, reasoningOrigin: ReasoningOrigin, capabilities: Capabilities): Record<string, unknown>;
  renderWire?(request: AdapterRequest, target: AdapterTarget, options: RenderWireOptions): Record<string, unknown>;
  toolChoiceWire(capabilities: Capabilities, target: AdapterTarget): ToolChoiceWire;
};
