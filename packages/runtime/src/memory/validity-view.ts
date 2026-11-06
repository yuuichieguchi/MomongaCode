import { validityOf } from '@momonga/memory';
import type { MemoryView } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';

export const withValidity = (store: Pick<RuntimeStore, 'memories'>, view: MemoryView): MemoryView => {
  const successorTimes = view.supersededBy.flatMap((id) => {
    const successor = store.memories.get(id);
    return successor === undefined ? [] : [successor.createdAt];
  });
  const validity = validityOf({
    observations: store.memories.observations(view.id),
    createdAt: view.createdAt,
    successorCreatedAt: successorTimes.length === 0 ? null : Math.min(...successorTimes),
    retiredAt: view.retiredAt,
  });
  return { ...view, validity };
};
