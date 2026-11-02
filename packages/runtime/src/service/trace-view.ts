import { summarizeRun } from '@momonga/observability';
import type { TraceStore } from '@momonga/observability';
import type { RunTraceView } from '@momonga/protocol';

export const runTraceOf = (store: TraceStore, runId: string): RunTraceView | undefined => {
  const spans = store.spansForRun(runId);
  if (spans.length === 0) return undefined;
  return {
    runId,
    summary: summarizeRun(store, runId),
    spans: spans.map((span) => ({
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: span.kind,
      startMs: span.startMs,
      endMs: span.endMs,
      status: span.status,
      attributes: span.attributes,
    })),
  };
};
