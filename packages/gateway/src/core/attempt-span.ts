import { recordChatRequestContent, recordChatResponse, recordChatResponseContent, recordError, startChatSpan } from '@momonga/observability';
import type { ChatBilling, Telemetry } from '@momonga/observability';
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
  request: { input: readonly AdapterInputItem[]; instructions: string | null | undefined; tools: readonly FunctionTool[] | null | undefined };
};

export type AttemptSpan = {
  note(name: string, message: string): void;
  succeed(info: { responseModel: string; responseId: string; finishReason: string; usage: Usage; output: readonly ItemField[] }): void;
  fail(errorType: string, error: unknown, message: string): void;
};

const inactive: AttemptSpan = { note: () => undefined, succeed: () => undefined, fail: () => undefined };

export const startAttemptSpan = (input: AttemptSpanInput): AttemptSpan => {
  if (input.telemetry === undefined) return inactive;
  const span = startChatSpan(
    input.telemetry.tracer,
    {
      providerName: input.providerName,
      billing: input.billing,
      requestModel: input.requestModel,
      stream: input.stream,
      attempt: input.attempt,
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.step === undefined ? {} : { step: input.step }),
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
    note: (name, message) => {
      if (!ended) span.addEvent(name, { message });
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
          cachedInputTokens: info.usage.input_tokens_details.cached_tokens,
          reasoningTokens: info.usage.output_tokens_details.reasoning_tokens,
        },
      });
      if (telemetry.captureMessageContent) recordChatResponseContent(span, chatResponseMessagesOf(info.output, info.finishReason));
      end();
    },
    fail: (errorType, error, message) => {
      if (ended) return;
      recordError(span, error, errorType, message);
      end();
    },
  };
};
