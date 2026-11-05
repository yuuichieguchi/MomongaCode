import type { RunState } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';

type Store = Pick<RuntimeStore, 'readLatestRunEventBefore'>;

export type RenderedForms = { forms: ReadonlyMap<string, number>; renderedFull: ReadonlySet<string> };

const callIdsOfOutputs = (body: unknown): string[] => {
  if (typeof body !== 'object' || body === null || !('input' in body) || !Array.isArray(body.input)) return [];
  return body.input.flatMap((item: unknown) =>
    typeof item === 'object' && item !== null && 'type' in item && item.type === 'function_call_output' && 'call_id' in item && typeof item.call_id === 'string'
      ? [item.call_id]
      : [],
  );
};

export const renderedFormsOf = (store: Store, state: RunState): RenderedForms | undefined => {
  const previous = store.readLatestRunEventBefore(state.runId, 'model.requested', state.lastSeq + 1);
  if (previous === undefined) return undefined;
  if (state.lastCompactionSeq > previous.seq) return undefined;
  return { forms: new Map(Object.entries(state.formsSinceCompaction)), renderedFull: new Set(callIdsOfOutputs(previous.body)) };
};
