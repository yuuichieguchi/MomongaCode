import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Context, Span, Tracer } from '@opentelemetry/api';
import type { FallbackCause } from '@momonga/protocol';
import type { UsageSource } from '@momonga/protocol';
import { EXCEPTION_EVENT, GENAI_CONTENT_SEMCONV, GENAI_SEMCONV, MOMONGA_ATTRIBUTES, OPERATIONS } from './semconv.ts';

const A = GENAI_SEMCONV.attributes;
const C = GENAI_CONTENT_SEMCONV;

export type AgentSpanInput = {
  agentName: string;
  agentId: string;
  conversationId: string;
  runId: string;
  step?: number;
  attempt?: number;
};

export type ChatBilling = 'metered' | 'local' | 'plan';

export type ChatSpanInput = {
  providerName: string;
  billing: ChatBilling;
  requestModel: string;
  maxTokens?: number;
  stream: boolean;
  runId?: string;
  step?: number;
  attempt: number;
  retryOf?: number;
  target?: string;
  role?: string;
  startTimeMs?: number;
};

export type ToolSpanInput = {
  toolName: string;
  toolCallId: string;
  toolType: string;
  runId: string;
  step: number;
};

export type ChatUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
};

export type GenAiPart =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'tool_call_response'; id: string; response: unknown };

export type GenAiMessage = { role: string; parts: readonly GenAiPart[]; finish_reason?: string };

export type GenAiToolDefinition = { type: 'function'; name: string; description?: string; parameters?: unknown };

export type ChatRequestContent = {
  systemInstructions?: readonly GenAiPart[];
  inputMessages: readonly GenAiMessage[];
  toolDefinitions?: readonly GenAiToolDefinition[];
};

export type ToolContent = { arguments: unknown; result?: unknown };

export type ChatResponse = {
  responseModel?: string;
  responseId?: string;
  finishReasons: readonly string[];
  usage: ChatUsage;
  usageSource: UsageSource;
  timeToFirstChunkMs?: number;
};

export const startAgentSpan = (tracer: Tracer, input: AgentSpanInput, parent?: Context): Span =>
  tracer.startSpan(
    `${OPERATIONS.agent} ${input.agentName}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        [A.ATTR_GEN_AI_OPERATION_NAME]: OPERATIONS.agent,
        [A.ATTR_GEN_AI_AGENT_NAME]: input.agentName,
        [A.ATTR_GEN_AI_AGENT_ID]: input.agentId,
        [A.ATTR_GEN_AI_CONVERSATION_ID]: input.conversationId,
        [MOMONGA_ATTRIBUTES.runId]: input.runId,
        ...(input.step === undefined ? {} : { [MOMONGA_ATTRIBUTES.step]: input.step }),
        ...(input.attempt === undefined ? {} : { [MOMONGA_ATTRIBUTES.attempt]: input.attempt }),
      },
    },
    parent,
  );

export const startChatSpan = (tracer: Tracer, input: ChatSpanInput, parent?: Context): Span =>
  tracer.startSpan(
    `${OPERATIONS.chat} ${input.requestModel}`,
    {
      kind: SpanKind.CLIENT,
      ...(input.startTimeMs === undefined ? {} : { startTime: input.startTimeMs }),
      attributes: {
        [A.ATTR_GEN_AI_OPERATION_NAME]: OPERATIONS.chat,
        [A.ATTR_GEN_AI_PROVIDER_NAME]: input.providerName,
        [MOMONGA_ATTRIBUTES.billing]: input.billing,
        [A.ATTR_GEN_AI_REQUEST_MODEL]: input.requestModel,
        ...(input.maxTokens === undefined ? {} : { [A.ATTR_GEN_AI_REQUEST_MAX_TOKENS]: input.maxTokens }),
        [A.ATTR_GEN_AI_REQUEST_STREAM]: input.stream,
        ...(input.runId === undefined ? {} : { [MOMONGA_ATTRIBUTES.runId]: input.runId }),
        ...(input.step === undefined ? {} : { [MOMONGA_ATTRIBUTES.step]: input.step }),
        [MOMONGA_ATTRIBUTES.attempt]: input.attempt,
        ...(input.retryOf === undefined ? {} : { [MOMONGA_ATTRIBUTES.retryOf]: input.retryOf }),
        ...(input.target === undefined ? {} : { [MOMONGA_ATTRIBUTES.target]: input.target }),
        ...(input.role === undefined ? {} : { [MOMONGA_ATTRIBUTES.role]: input.role }),
      },
    },
    parent,
  );

export const recordChatFailure = (span: Span, message: string): void => {
  span.setAttribute(MOMONGA_ATTRIBUTES.failureMessage, message);
};

export const recordFallbackCauses = (span: Span, causes: readonly FallbackCause[]): void => {
  if (causes.length > 0) span.setAttribute(MOMONGA_ATTRIBUTES.fallbackCauses, JSON.stringify(causes));
};

export const recordChatResponse = (span: Span, response: ChatResponse): void => {
  span.setAttributes({
    ...(response.responseModel === undefined ? {} : { [A.ATTR_GEN_AI_RESPONSE_MODEL]: response.responseModel }),
    ...(response.responseId === undefined ? {} : { [A.ATTR_GEN_AI_RESPONSE_ID]: response.responseId }),
    [A.ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: [...response.finishReasons],
    [A.ATTR_GEN_AI_USAGE_INPUT_TOKENS]: response.usage.inputTokens,
    [A.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: response.usage.outputTokens,
    [MOMONGA_ATTRIBUTES.usageSource]: response.usageSource,
    ...(response.usage.cachedInputTokens === undefined
      ? {}
      : { [A.ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: response.usage.cachedInputTokens }),
    ...(response.usage.cacheWriteInputTokens === undefined
      ? {}
      : { [A.ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: response.usage.cacheWriteInputTokens }),
    ...(response.usage.reasoningTokens === undefined
      ? {}
      : { [A.ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]: response.usage.reasoningTokens }),
    ...(response.timeToFirstChunkMs === undefined
      ? {}
      : { [A.ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK]: response.timeToFirstChunkMs / 1000 }),
  });
};

export const recordChatRequestContent = (span: Span, content: ChatRequestContent): void => {
  span.setAttributes({
    ...(content.systemInstructions === undefined ? {} : { [C.ATTR_GEN_AI_SYSTEM_INSTRUCTIONS]: JSON.stringify(content.systemInstructions) }),
    [C.ATTR_GEN_AI_INPUT_MESSAGES]: JSON.stringify(content.inputMessages),
    ...(content.toolDefinitions === undefined ? {} : { [C.ATTR_GEN_AI_TOOL_DEFINITIONS]: JSON.stringify(content.toolDefinitions) }),
  });
};

export const recordChatResponseContent = (span: Span, outputMessages: readonly GenAiMessage[]): void => {
  span.setAttribute(C.ATTR_GEN_AI_OUTPUT_MESSAGES, JSON.stringify(outputMessages));
};

export type ToolBackendAttributes = { source: string; version: string };

export const recordToolBackend = (span: Span, backend: ToolBackendAttributes): void => {
  span.setAttributes({ [MOMONGA_ATTRIBUTES.toolBackendSource]: backend.source, [MOMONGA_ATTRIBUTES.toolBackendVersion]: backend.version });
};

export const recordToolContent = (span: Span, content: ToolContent): void => {
  span.setAttributes({
    [C.ATTR_GEN_AI_TOOL_CALL_ARGUMENTS]: JSON.stringify(content.arguments),
    ...(content.result === undefined ? {} : { [C.ATTR_GEN_AI_TOOL_CALL_RESULT]: JSON.stringify(content.result) }),
  });
};

export const startToolSpan = (tracer: Tracer, input: ToolSpanInput, parent?: Context): Span =>
  tracer.startSpan(
    `${OPERATIONS.tool} ${input.toolName}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        [A.ATTR_GEN_AI_OPERATION_NAME]: OPERATIONS.tool,
        [A.ATTR_GEN_AI_TOOL_NAME]: input.toolName,
        [A.ATTR_GEN_AI_TOOL_CALL_ID]: input.toolCallId,
        [A.ATTR_GEN_AI_TOOL_TYPE]: input.toolType,
        [MOMONGA_ATTRIBUTES.runId]: input.runId,
        [MOMONGA_ATTRIBUTES.step]: input.step,
      },
    },
    parent,
  );

const typeNameOf = (thrown: unknown): string => {
  if (typeof thrown !== 'object' || thrown === null) return typeof thrown;
  const constructor: unknown = Object.getPrototypeOf(thrown)?.constructor;
  return typeof constructor === 'function' && constructor.name !== '' ? constructor.name : 'object';
};

export const recordError = (span: Span, error: unknown, errorType: string, safeMessage?: string): void => {
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.setAttribute(A.ATTR_ERROR_TYPE, errorType);
  span.addEvent(EXCEPTION_EVENT.name, {
    [EXCEPTION_EVENT.type]: typeNameOf(error),
    ...(safeMessage === undefined ? {} : { [EXCEPTION_EVENT.message]: safeMessage }),
  });
};
