import {
  recordChatFailure,
  recordChatRequestContent,
  recordChatResponse,
  recordChatResponseContent,
  recordChatUsage,
  recordError,
  recordFallbackCauses,
  startChatSpan,
} from '@momonga/observability';
import type { ChatBilling, Telemetry } from '@momonga/observability';
import { MOMONGA_EVENTS } from '@momonga/protocol';
import type { AdapterInputItem, FallbackCause, FunctionTool, ItemField, Usage, UsageSource } from '@momonga/protocol';
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
  retryOf: number | undefined;
  targetName: string;
  role: string;
  startedAtMs: number;
  request: { input: readonly AdapterInputItem[]; instructions: string | null | undefined; tools: readonly FunctionTool[] | null | undefined };
};

export type BilledUsage = { usage: Usage; usageSource: UsageSource; cacheWriteInputTokens: number | undefined };

const chatUsageOf = (billed: BilledUsage) => ({
  inputTokens: billed.usage.input_tokens,
  outputTokens: billed.usage.output_tokens,
  ...(billed.usage.input_tokens_details.cached_tokens === undefined ? {} : { cachedInputTokens: billed.usage.input_tokens_details.cached_tokens }),
  ...(billed.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: billed.cacheWriteInputTokens }),
  reasoningTokens: billed.usage.output_tokens_details.reasoning_tokens,
});

export type AttemptSpan = {
  readonly startedAtMs: number;
  note(name: string, message: string): void;
  committed(): void;
  succeed(info: {
    responseModel: string;
    responseId: string;
    finishReason: string;
    usage: Usage;
    usageSource: UsageSource;
    cacheWriteInputTokens?: number;
    output: readonly ItemField[];
    fallbackCauses: readonly FallbackCause[];
  }): void;
  fail(errorType: string, error: unknown, message: string, billed?: BilledUsage): void;
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
      ...(input.retryOf === undefined ? {} : { retryOf: input.retryOf }),
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
        usageSource: info.usageSource,
        usage: chatUsageOf({ usage: info.usage, usageSource: info.usageSource, cacheWriteInputTokens: info.cacheWriteInputTokens }),
      });
      recordFallbackCauses(span, info.fallbackCauses);
      if (telemetry.captureMessageContent) recordChatResponseContent(span, chatResponseMessagesOf(info.output, info.finishReason));
      end();
    },
    fail: (errorType, error, message, billed) => {
      if (ended) return;
      if (billed !== undefined) recordChatUsage(span, chatUsageOf(billed), billed.usageSource);
      recordError(span, error, errorType, message);
      recordChatFailure(span, message);
      end();
    },
  };
};
