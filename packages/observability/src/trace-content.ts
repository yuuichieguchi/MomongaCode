import { MAX_TRACE_CONTENT_PAGE } from '@momonga/protocol';
import type { TraceContentPage } from '@momonga/protocol';
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
