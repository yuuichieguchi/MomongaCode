import { GENAI_SEMCONV, MOMONGA_ATTRIBUTES, OPERATIONS } from './semconv.ts';
import { billedUsageOf, isBilledChat } from './billed-calls.ts';
import { isCacheReadReported, noCallReported } from './cache-reads.ts';
import type { SpanRecord, TraceStore } from './trace-store.ts';

const A = GENAI_SEMCONV.attributes;

export type ChatResult = { step: number; attempt: number; finishReasons: string[] };

export type RunSummary = {
  steps: number;
  chatCalls: number;
  sideCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
  cacheReadNotReportedCalls: number;
  errorCount: number;
  durationMs: number;
  chatResults: ChatResult[];
};

const numberAttribute = (span: SpanRecord, key: string): number => {
  const value = span.attributes[key];
  if (value === undefined) return 0;
  if (typeof value !== 'number') throw new TypeError(`span ${span.spanId} attribute ${key} must be a number`);
  return value;
};

const requiredNumber = (span: SpanRecord, key: string): number => {
  const value = span.attributes[key];
  if (typeof value !== 'number') throw new TypeError(`span ${span.spanId} attribute ${key} must be a number`);
  return value;
};

const writtenNumber = (span: SpanRecord, key: string): number | undefined => (span.attributes[key] === undefined ? undefined : requiredNumber(span, key));

const finishReasonsOf = (span: SpanRecord): string[] => {
  const value = span.attributes[A.ATTR_GEN_AI_RESPONSE_FINISH_REASONS];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((reason) => typeof reason === 'string')) {
    throw new TypeError(`span ${span.spanId} attribute ${A.ATTR_GEN_AI_RESPONSE_FINISH_REASONS} must be a string array`);
  }
  return value.filter((reason): reason is string => typeof reason === 'string');
};

export const summarizeRun = (store: TraceStore, runId: string): RunSummary => summarizeSpans(store.spansForRun(runId));

export const summarizeSpans = (spans: readonly SpanRecord[]): RunSummary => {
  const chats = spans.filter((span) => span.attributes[A.ATTR_GEN_AI_OPERATION_NAME] === OPERATIONS.chat);
  const tools = spans.filter((span) => span.attributes[A.ATTR_GEN_AI_OPERATION_NAME] === OPERATIONS.tool);
  const steps = new Set(
    spans.flatMap((span) => {
      const step = span.attributes[MOMONGA_ATTRIBUTES.step];
      return typeof step === 'number' ? [step] : [];
    }),
  );
  const sum = (key: string): number => chats.reduce((total, span) => total + numberAttribute(span, key), 0);
  const billedUsages = chats.filter(isBilledChat).map(billedUsageOf);
  const reportedUsages = billedUsages.filter(isCacheReadReported);
  const cacheRead = { calls: billedUsages.length, notReported: billedUsages.length - reportedUsages.length };
  const chatResults = chats.flatMap((span): ChatResult[] => {
    const step = writtenNumber(span, MOMONGA_ATTRIBUTES.step);
    return step === undefined ? [] : [{ step, attempt: requiredNumber(span, MOMONGA_ATTRIBUTES.attempt), finishReasons: finishReasonsOf(span) }];
  });
  const first = spans.reduce((earliest, span) => Math.min(earliest, span.startMs), Number.POSITIVE_INFINITY);
  const last = spans.reduce((latest, span) => Math.max(latest, span.endMs), Number.NEGATIVE_INFINITY);
  return {
    steps: steps.size,
    chatCalls: chats.length,
    sideCalls: chats.length - chatResults.length,
    toolCalls: tools.length,
    inputTokens: sum(A.ATTR_GEN_AI_USAGE_INPUT_TOKENS),
    outputTokens: sum(A.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS),
    cachedInputTokens: noCallReported(cacheRead) ? null : reportedUsages.reduce((total, usage) => total + usage.cachedInputTokens, 0),
    cacheReadNotReportedCalls: cacheRead.notReported,
    errorCount: spans.filter((span) => span.status === 'ERROR').length,
    durationMs: spans.length === 0 ? 0 : last - first,
    chatResults,
  };
};
