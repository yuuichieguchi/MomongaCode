import { summarizeSpans } from '@momonga/observability';
import type { SpanRecord, TraceStore } from '@momonga/observability';
import type { RunTraceView } from '@momonga/protocol';
import type { GatewayClient } from '../gateway-client.ts';

export type RunSpanSources = {
  local: Pick<TraceStore, 'spansForRun'>;
  gateway: Pick<GatewayClient, 'runSpans'>;
};

const byTime = (left: SpanRecord, right: SpanRecord): number => left.startMs - right.startMs || right.endMs - left.endMs;

export const runTraceOf = async (sources: RunSpanSources, runId: string, signal: AbortSignal): Promise<RunTraceView | undefined> => {
  const spans = [...sources.local.spansForRun(runId), ...(await sources.gateway.runSpans(runId, signal))].sort(byTime);
  if (spans.length === 0) return undefined;
  return {
    runId,
    summary: summarizeSpans(spans),
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
