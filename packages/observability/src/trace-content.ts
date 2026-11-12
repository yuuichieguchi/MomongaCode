import { MAX_RUN_SPANS_PAGE, MAX_TRACE_CONTENT_PAGE } from '@momonga/protocol';
import type { RunSpansPage, TraceContentPage } from '@momonga/protocol';
import type { TraceStore } from './trace-store.ts';

export { MAX_TRACE_CONTENT_PAGE };

export const pageRunBodies = (store: Pick<TraceStore, 'bodiesOfRunAfter'>, runId: string, afterId: number, limit: number): TraceContentPage => {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRACE_CONTENT_PAGE) throw new RangeError(`a page holds 1 to ${MAX_TRACE_CONTENT_PAGE} bodies, received ${limit}`);
  if (!Number.isInteger(afterId) || afterId < 0) throw new RangeError(`the cursor of a content page is a non-negative integer, received ${afterId}`);
  const found = store.bodiesOfRunAfter(runId, afterId, limit + 1);
  const shown = found.slice(0, limit);
  const last = shown.at(-1);
  return {
    bodies: shown.map(({ id, body }) => ({ id, spanId: body.spanId, kind: body.kind, content: body.content, createdAtMs: body.createdAtMs, expiresAtMs: body.expiresAtMs })),
    next: found.length > limit && last !== undefined ? last.id : null,
  };
};

export const pageRunSpans = (store: Pick<TraceStore, 'spansOfRunAfter'>, runId: string, afterSeq: number, limit: number): RunSpansPage => {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RUN_SPANS_PAGE) throw new RangeError(`a page holds 1 to ${MAX_RUN_SPANS_PAGE} spans, received ${limit}`);
  if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new RangeError(`the cursor of a span page is a non-negative integer, received ${afterSeq}`);
  const found = store.spansOfRunAfter(runId, afterSeq, limit + 1);
  const shown = found.slice(0, limit);
  const last = shown.at(-1);
  return {
    spans: shown.map(({ span }) => ({
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
    next: found.length > limit && last !== undefined ? last.seq : null,
  };
};
