import type { RunEvent } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';

type Store = Pick<RuntimeStore, 'readRunEventsOfTypes' | 'readLatestRunEventBefore'>;

export type RenderedForms = { forms: ReadonlyMap<string, number>; renderedFull: ReadonlySet<string> };

const callIdsOfOutputs = (body: unknown): string[] => {
  if (typeof body !== 'object' || body === null || !('input' in body) || !Array.isArray(body.input)) return [];
  return body.input.flatMap((item: unknown) =>
    typeof item === 'object' && item !== null && 'type' in item && item.type === 'function_call_output' && 'call_id' in item && typeof item.call_id === 'string'
      ? [item.call_id]
      : [],
  );
};

export const formsSinceCompaction = (events: readonly RunEvent[]): Map<string, number> => {
  const lastCompaction = events.findLast((event) => event.type === 'context.compacted' || event.type === 'context.compaction_rejected');
  const afterSeq = lastCompaction?.seq ?? 0;
  const kept = new Map<string, number>();
  for (const event of events) {
    if (event.seq <= afterSeq) continue;
    if (event.type === 'context.truncated' && event.kind === 'truncated' && event.keptChars !== undefined) kept.set(event.callId, event.keptChars);
    if (event.type === 'context.truncated' && event.kind !== 'truncated') kept.delete(event.callId);
  }
  return kept;
};

export const FORM_EVENT_TYPES = ['context.truncated', 'context.compacted', 'context.compaction_rejected'] as const;

export const renderedFormsOf = (store: Store, runId: string, lastSeq: number): RenderedForms | undefined => {
  const previous = store.readLatestRunEventBefore(runId, 'model.requested', lastSeq + 1);
  if (previous === undefined) return undefined;
  const events = store.readRunEventsOfTypes(runId, [...FORM_EVENT_TYPES]);
  if (events.some((event) => event.seq > previous.seq && (event.type === 'context.compacted' || event.type === 'context.compaction_rejected'))) return undefined;
  return { forms: formsSinceCompaction(events), renderedFull: new Set(callIdsOfOutputs(previous.body)) };
};
