import {
  recordChatFailure,
  recordChatRequestContent,
  recordChatResponse,
  recordChatResponseContent,
  recordError,
  recordFallbackCauses,
  startChatSpan,
} from '@momonga/observability';
import type { FallbackCause } from '@momonga/foundation';
import type { ChatBilling, Telemetry } from '@momonga/observability';
import { MOMONGA_EVENTS } from '@momonga/protocol';
import type { AdapterInputItem, FunctionTool, ItemField, Usage } from '@momonga/protocol';
import { chatRequestContentOf, chatResponseMessagesOf } from './chat-content.ts';

export type TraceParent = ReturnType<Telemetry['propagation']['extract']>;

export type AttemptSpanInput = {
  telemetry: Telemetry | undefined;
  parent: TraceParent | undefined;
  providerName: string;
  billing: ChatBilling;
  requestModel: string;
  maxTokens: number | undefined;
  stream: boolean;
  runId: string | undefined;
  step: number | undefined;
  attempt: number;
  targetName: string;
  role: string;
  startedAtMs: number;
  request: { input: readonly AdapterInputItem[]; instructions: string | null | undefined; tools: readonly FunctionTool[] | null | undefined };
};

export type AttemptSpan = {
  readonly startedAtMs: number;
  note(name: string, message: string): void;
  committed(): void;
  succeed(info: {
    responseModel: string;
    responseId: string;
    finishReason: string;
    usage: Usage;
    cacheWriteInputTokens?: number;
    output: readonly ItemField[];
    fallbackCauses: readonly FallbackCause[];
  }): void;
  fail(errorType: string, error: unknown, message: string): void;
};

export const startAttemptSpan = (input: AttemptSpanInput): AttemptSpan => {
  if (input.telemetry === undefined) return { startedAtMs: input.startedAtMs, note: () => undefined, committed: () => undefined, succeed: () => undefined, fail: () => undefined };
  const span = startChatSpan(
    input.telemetry.tracer,
    {
      providerName: input.providerName,
      billing: input.billing,
      requestModel: input.requestModel,
      stream: input.stream,
      attempt: input.attempt,
      target: input.targetName,
      role: input.role,
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.step === undefined ? {} : { step: input.step }),
      startTimeMs: input.startedAtMs,
    },
    input.parent,
  );
  const { telemetry } = input;
  if (telemetry.captureMessageContent) {
    recordChatRequestContent(span, chatRequestContentOf(input.request.input, input.request.instructions, input.request.tools));
  }
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    span.end();
  };
  return {
    startedAtMs: input.startedAtMs,
    note: (name, message) => {
      if (!ended) span.addEvent(name, { message });
    },
    committed: () => {
      if (!ended) span.addEvent(MOMONGA_EVENTS.responseCommitted);
    },
    succeed: (info) => {
      if (ended) return;
      recordChatResponse(span, {
        responseModel: info.responseModel,
        responseId: info.responseId,
        finishReasons: [info.finishReason],
        usage: {
          inputTokens: info.usage.input_tokens,
          outputTokens: info.usage.output_tokens,
          ...(info.usage.input_tokens_details.cached_tokens === undefined ? {} : { cachedInputTokens: info.usage.input_tokens_details.cached_tokens }),
          ...(info.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: info.cacheWriteInputTokens }),
          reasoningTokens: info.usage.output_tokens_details.reasoning_tokens,
        },
      });
      recordFallbackCauses(span, info.fallbackCauses);
      if (telemetry.captureMessageContent) recordChatResponseContent(span, chatResponseMessagesOf(info.output, info.finishReason));
      end();
    },
    fail: (errorType, error, message) => {
      if (ended) return;
      recordError(span, error, errorType, message);
      recordChatFailure(span, message);
      end();
    },
  };
};
