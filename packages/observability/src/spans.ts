import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Context, Span, Tracer } from '@opentelemetry/api';
import { EXCEPTION_EVENT, GENAI_SEMCONV, MOMONGA_ATTRIBUTES, OPERATIONS } from './semconv.ts';

const A = GENAI_SEMCONV.attributes;

export type AgentSpanInput = {
  agentName: string;
  agentId: string;
  conversationId: string;
  runId: string;
  step?: number;
  attempt?: number;
};

export type ChatSpanInput = {
  providerName: string;
  requestModel: string;
  maxTokens?: number;
  stream: boolean;
  runId?: string;
  step?: number;
  attempt: number;
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
  reasoningTokens?: number;
};

export type ChatResponse = {
  responseModel?: string;
  responseId?: string;
  finishReasons: readonly string[];
  usage: ChatUsage;
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
      attributes: {
        [A.ATTR_GEN_AI_OPERATION_NAME]: OPERATIONS.chat,
        [A.ATTR_GEN_AI_PROVIDER_NAME]: input.providerName,
        [A.ATTR_GEN_AI_REQUEST_MODEL]: input.requestModel,
        ...(input.maxTokens === undefined ? {} : { [A.ATTR_GEN_AI_REQUEST_MAX_TOKENS]: input.maxTokens }),
        [A.ATTR_GEN_AI_REQUEST_STREAM]: input.stream,
        ...(input.runId === undefined ? {} : { [MOMONGA_ATTRIBUTES.runId]: input.runId }),
        ...(input.step === undefined ? {} : { [MOMONGA_ATTRIBUTES.step]: input.step }),
        [MOMONGA_ATTRIBUTES.attempt]: input.attempt,
      },
    },
    parent,
  );

export const recordChatResponse = (span: Span, response: ChatResponse): void => {
  span.setAttributes({
    ...(response.responseModel === undefined ? {} : { [A.ATTR_GEN_AI_RESPONSE_MODEL]: response.responseModel }),
    ...(response.responseId === undefined ? {} : { [A.ATTR_GEN_AI_RESPONSE_ID]: response.responseId }),
    [A.ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: [...response.finishReasons],
    [A.ATTR_GEN_AI_USAGE_INPUT_TOKENS]: response.usage.inputTokens,
    [A.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: response.usage.outputTokens,
    ...(response.usage.cachedInputTokens === undefined
      ? {}
      : { [A.ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: response.usage.cachedInputTokens }),
    ...(response.usage.reasoningTokens === undefined
      ? {}
      : { [A.ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]: response.usage.reasoningTokens }),
    ...(response.timeToFirstChunkMs === undefined
      ? {}
      : { [A.ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK]: response.timeToFirstChunkMs / 1000 }),
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
