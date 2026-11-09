import type { SchemaNarrowing } from './dialect.ts';
import type { ModelCost } from './token-anatomy.ts';

export const OPEN_RESPONSES_VERSION = '2026-04-24' as const;

export const OPEN_RESPONSES_STREAM_EVENT_TYPES = [
  'response.created',
  'response.queued',
  'response.in_progress',
  'response.completed',
  'response.failed',
  'response.incomplete',
  'response.output_item.added',
  'response.output_item.done',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.refusal.delta',
  'response.refusal.done',
  'response.reasoning.delta',
  'response.reasoning.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.output_text.annotation.added',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'error',
] as const;

export const TERMINAL_STREAM_EVENT_TYPES = ['response.completed', 'response.failed', 'response.incomplete'] as const;

export const ERROR_TYPES = ['invalid_request', 'not_found', 'too_many_requests', 'server_error', 'model_error'] as const;

export type StreamEventType = (typeof OPEN_RESPONSES_STREAM_EVENT_TYPES)[number];
export type TerminalStreamEventType = (typeof TERMINAL_STREAM_EVENT_TYPES)[number];
export type ErrorType = (typeof ERROR_TYPES)[number];

export type ErrorBody = { message: string; type: ErrorType; param: string | null; code: string | null };
export type ErrorEnvelope = { error: ErrorBody };

export type Annotation = { type: string; [key: string]: unknown };

export type InputTextPart = { type: 'input_text'; text: string };
export type OutputTextPart = { type: 'output_text'; text: string; annotations?: Annotation[] };
export type SummaryTextPart = { type: 'summary_text'; text: string };
export type RefusalPart = { type: 'refusal'; refusal: string };
export type ReasoningTextPart = { type: 'reasoning_text'; text: string };
export type InputImagePart = { type: 'input_image'; image_url?: string | null; detail?: 'low' | 'high' | 'auto' };
export type InputFilePart = {
  type: 'input_file';
  filename?: string;
  file_data?: string;
  file_url?: string;
};
export type ContentPart = InputTextPart | OutputTextPart | SummaryTextPart | ReasoningTextPart | RefusalPart | InputImagePart | InputFilePart;

export const CHAT_REASONING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_text'] as const;
export type ChatReasoningField = (typeof CHAT_REASONING_FIELDS)[number];

export type ItemStatus = 'in_progress' | 'completed' | 'incomplete';

export type MessageItem = {
  type: 'message';
  id: string;
  status: ItemStatus;
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: ContentPart[];
  phase?: 'commentary' | 'final_answer';
};

export type FunctionCallItem = {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: ItemStatus;
};

export type FunctionCallOutputItem = {
  type: 'function_call_output';
  id: string;
  call_id: string;
  output: string | ContentPart[];
  status: ItemStatus;
};

export type ReasoningItem = {
  type: 'reasoning';
  id: string;
  summary: ContentPart[];
  content?: ContentPart[];
  encrypted_content?: string;
  reasoning_field?: ChatReasoningField;
  signature?: string;
};

export type CompactionItem = { type: 'compaction'; id: string; encrypted_content: string; created_by?: string };

export type ItemField = MessageItem | FunctionCallItem | FunctionCallOutputItem | ReasoningItem | CompactionItem;

export type MessageInputItem = {
  type: 'message';
  id?: string | null;
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | ContentPart[];
  status?: string | null;
  phase?: 'commentary' | 'final_answer';
};

export type FunctionCallInputItem = {
  type: 'function_call';
  id?: string | null;
  call_id: string;
  name: string;
  arguments: string;
  status?: ItemStatus | null;
};

export type FunctionCallOutputInputItem = {
  type: 'function_call_output';
  id?: string | null;
  call_id: string;
  output: string | ContentPart[];
  status?: ItemStatus | null;
};

export type ReasoningInputItem = {
  type: 'reasoning';
  id?: string | null;
  summary: ContentPart[];
  content?: ContentPart[] | null;
  encrypted_content?: string | null;
  reasoning_field?: ChatReasoningField | null;
  signature?: string | null;
};

export type CompactionInputItem = { type: 'compaction'; id?: string | null; encrypted_content: string };

export type InputItem =
  | MessageInputItem
  | FunctionCallInputItem
  | FunctionCallOutputInputItem
  | ReasoningInputItem
  | CompactionInputItem;

export type FunctionTool = {
  type: 'function';
  name: string;
  description?: string | null;
  parameters?: Record<string, unknown> | null;
  strict?: boolean;
};

export type FitRankedFunctionTool = FunctionTool & { fitRank: number; fitTier: string };

export type ResponseFunctionTool = {
  type: 'function';
  name: string;
  description: string | null;
  parameters: Record<string, unknown> | null;
  strict: boolean;
};

export type ToolChoiceMode = 'auto' | 'required' | 'none';

export type AllowedToolsChoice = { type: 'allowed_tools'; tools: Array<{ type: 'function'; name: string }>; mode?: ToolChoiceMode };

export type ToolChoice = 'none' | 'auto' | 'required' | { type: 'function'; name: string } | AllowedToolsChoice;

export type ResponseToolChoice = Exclude<ToolChoice, AllowedToolsChoice> | (AllowedToolsChoice & { mode: ToolChoiceMode });

export type TextFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; description?: string; schema: Record<string, unknown>; strict?: boolean | null };

export type ResponseTextFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; description: string | null; schema: null; strict: boolean };

export type TextField = { format?: TextFormat | null; verbosity?: 'low' | 'medium' | 'high' };

export type ResponseTextField = { format: ResponseTextFormat; verbosity?: 'low' | 'medium' | 'high' };

export type ReasoningConfig = { effort?: string | null; summary?: string | null };

export type ResponseReasoning = { effort: string | null; summary: string | null };

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details: { cached_tokens?: number };
  output_tokens_details: { reasoning_tokens: number };
};

export const cachedDetailOf = (cachedTokens: number | undefined): Usage['input_tokens_details'] =>
  cachedTokens === undefined ? {} : { cached_tokens: cachedTokens };

export type WireUsage = Omit<Usage, 'input_tokens_details'> & { input_tokens_details: { cached_tokens: number } };

export const wireUsageOf = (usage: Usage): { usage: WireUsage; cacheReadNotReported?: true } =>
  usage.input_tokens_details.cached_tokens === undefined
    ? { usage: { ...usage, input_tokens_details: { cached_tokens: 0 } }, cacheReadNotReported: true }
    : { usage: { ...usage, input_tokens_details: { cached_tokens: usage.input_tokens_details.cached_tokens } } };

export const reportedCachedTokensOf = (
  usage: { input_tokens_details?: { cached_tokens?: number } },
  extension: { cacheReadNotReported?: true } | undefined,
): number | undefined => (extension?.cacheReadNotReported === true ? undefined : usage.input_tokens_details?.cached_tokens);

export type ResponseError = { code: string; message: string; type?: ErrorType; retryAfterMs?: number };

export type FailedResponseResource = ResponseResource & { error: ResponseError };

export type ResponseStatus = 'in_progress' | 'completed' | 'failed' | 'incomplete' | 'queued';

export type JsonReplyPath = 'enforced' | 'prompt';

export type MomongaResponseExtension = {
  alias: string;
  target: string;
  counter: string;
  attempts: number;
  fallbackFrom?: string[];
  fallbackCauses?: { target: string; code: string | null; message: string }[];
  schemaNarrowings?: SchemaNarrowing[];
  jsonReply?: JsonReplyPath;
  usageSource: 'reported' | 'estimated';
  contextInputTokens?: number;
  cacheWriteInputTokens?: number;
  cacheReadNotReported?: true;
  cost?: ModelCost;
  retryable?: boolean;
};

export type ResponseResource = {
  id: string;
  object: 'response';
  created_at: number;
  completed_at: number | null;
  status: ResponseStatus;
  incomplete_details: { reason: string } | null;
  model: string;
  previous_response_id: string | null;
  instructions: string | null;
  output: ItemField[];
  error: ResponseError | null;
  tools: ResponseFunctionTool[];
  tool_choice: ResponseToolChoice;
  truncation: 'auto' | 'disabled';
  parallel_tool_calls: boolean;
  text: ResponseTextField;
  top_p: number;
  presence_penalty: number;
  frequency_penalty: number;
  top_logprobs: number;
  temperature: number;
  reasoning: ResponseReasoning | null;
  usage: Usage | null;
  max_output_tokens: number | null;
  max_tool_calls: number | null;
  store: boolean;
  background: boolean;
  service_tier: string;
  metadata: Record<string, string>;
  safety_identifier: string | null;
  prompt_cache_key: string | null;
  momonga?: MomongaResponseExtension;
  contextInputTokens?: number;
  cacheWriteInputTokens?: number;
  schemaNarrowings?: SchemaNarrowing[];
  jsonReply?: JsonReplyPath;
};

export type PromptCacheCounts = { stable: number; fixed: number; previousHistory?: number; history: number };

export type CreateResponseBody = {
  model: string;
  input?: string | InputItem[] | null;
  previous_response_id?: string | null;
  instructions?: string | null;
  tools?: FunctionTool[] | null;
  tool_choice?: ToolChoice | null;
  metadata?: Record<string, string> | null;
  text?: TextField | null;
  temperature?: number | null;
  top_p?: number | null;
  presence_penalty?: number | null;
  frequency_penalty?: number | null;
  parallel_tool_calls?: boolean | null;
  stream?: boolean;
  store?: boolean;
  max_output_tokens?: number | null;
  max_tool_calls?: number | null;
  truncation?: 'auto' | 'disabled' | null;
  reasoning?: ReasoningConfig | null;
  top_logprobs?: number | null;
  prompt_cache_key?: string | null;
  safety_identifier?: string | null;
  service_tier?: string | null;
  background?: boolean;
  momonga?: { cache?: PromptCacheCounts };
};

type ResponseEvent<T extends string> = { type: T; sequence_number: number; response: ResponseResource };
type ItemEvent<T extends string> = { type: T; sequence_number: number; output_index: number; item: ItemField };
type PartEvent<T extends string> = {
  type: T;
  sequence_number: number;
  item_id: string;
  output_index: number;
  content_index: number;
  part: ContentPart;
};
type SummaryPartEvent<T extends string> = {
  type: T;
  sequence_number: number;
  item_id: string;
  output_index: number;
  summary_index: number;
  part: ContentPart;
};
type ContentTextEvent<T extends string, Field extends string> = {
  type: T;
  sequence_number: number;
  item_id: string;
  output_index: number;
  content_index: number;
} & { [K in Field]: string };
type SummaryTextEvent<T extends string, Field extends string> = {
  type: T;
  sequence_number: number;
  item_id: string;
  output_index: number;
  summary_index: number;
} & { [K in Field]: string };

export type LogProb = { token: string; logprob: number; bytes: number[]; top_logprobs?: unknown[] };

export type StreamEvent =
  | ResponseEvent<'response.created'>
  | ResponseEvent<'response.queued'>
  | ResponseEvent<'response.in_progress'>
  | ResponseEvent<'response.completed'>
  | { type: 'response.failed'; sequence_number: number; response: FailedResponseResource }
  | ResponseEvent<'response.incomplete'>
  | ItemEvent<'response.output_item.added'>
  | ItemEvent<'response.output_item.done'>
  | SummaryPartEvent<'response.reasoning_summary_part.added'>
  | SummaryPartEvent<'response.reasoning_summary_part.done'>
  | PartEvent<'response.content_part.added'>
  | PartEvent<'response.content_part.done'>
  | (ContentTextEvent<'response.output_text.delta', 'delta'> & { logprobs?: LogProb[]; obfuscation?: string })
  | (ContentTextEvent<'response.output_text.done', 'text'> & { logprobs?: LogProb[] })
  | ContentTextEvent<'response.refusal.delta', 'delta'>
  | ContentTextEvent<'response.refusal.done', 'refusal'>
  | (ContentTextEvent<'response.reasoning.delta', 'delta'> & { obfuscation?: string })
  | ContentTextEvent<'response.reasoning.done', 'text'>
  | (SummaryTextEvent<'response.reasoning_summary_text.delta', 'delta'> & { obfuscation?: string })
  | SummaryTextEvent<'response.reasoning_summary_text.done', 'text'>
  | {
      type: 'response.output_text.annotation.added';
      sequence_number: number;
      item_id: string;
      output_index: number;
      content_index: number;
      annotation_index: number;
      annotation: Annotation | null;
    }
  | {
      type: 'response.function_call_arguments.delta';
      sequence_number: number;
      item_id: string;
      output_index: number;
      delta: string;
      obfuscation?: string;
    }
  | {
      type: 'response.function_call_arguments.done';
      sequence_number: number;
      item_id: string;
      output_index: number;
      arguments: string;
    }
  | { type: 'error'; sequence_number: number; error: ErrorBody; status?: number; retry_after_ms?: number; deferred?: true };

export const carriesOutput = (event: StreamEvent): boolean =>
  event.type === 'response.output_text.delta' ||
  event.type === 'response.reasoning.delta' ||
  event.type === 'response.reasoning_summary_text.delta' ||
  event.type === 'response.refusal.delta' ||
  event.type === 'response.function_call_arguments.delta' ||
  (event.type === 'response.output_item.added' && event.item.type === 'function_call');

export type CompactMomongaExtension = { max_summary_tokens?: number; retains_user_request?: boolean; guideline?: string };

export type CompactRequest = {
  model: string;
  input?: string | InputItem[] | null;
  previous_response_id?: string | null;
  instructions?: string | null;
  prompt_cache_key?: string | null;
  momonga?: CompactMomongaExtension;
};

export type CompactResource = {
  id: string;
  object: 'response.compaction';
  output: ItemField[];
  created_at: number;
  usage: Usage;
  momonga?: { target: string; cacheWriteInputTokens?: number; cacheReadNotReported?: true; cost?: ModelCost };
};
