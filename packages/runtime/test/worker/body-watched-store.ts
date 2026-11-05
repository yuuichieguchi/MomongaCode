import type { RuntimeStore } from '@momonga/store';

export const TOOL_OFFERED = 'tool.offered';

export type EventReads = { eventsReturned: number; bodyReads: string[] };

const BODY_TYPE = 'model.requested';

export const bodyWatchedStore = (store: RuntimeStore): { store: RuntimeStore; reads: EventReads } => {
  const reads: EventReads = { eventsReturned: 0, bodyReads: [] };
  const counted = <T>(value: T): T => {
    if (Array.isArray(value)) reads.eventsReturned += value.length;
    else if (value !== undefined && value !== null) reads.eventsReturned += 1;
    return value;
  };
  const guarded = new Proxy(store, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      if (property === 'readRunEvents') {
        return (...args: unknown[]) => {
          reads.bodyReads.push(`readRunEvents(${String(args[0])})`);
          return counted(method.call(target, ...args));
        };
      }
      if (property === 'readRunEventsOfTypes') {
        return (runId: string, types: readonly string[], ...rest: unknown[]) => {
          if (types.includes(BODY_TYPE)) {
            reads.bodyReads.push(`readRunEventsOfTypes(${runId}, ${types.join(',')})`);
          }
          return counted(method.call(target, runId, types, ...rest));
        };
      }
      if (property === 'readLatestRunEventBefore') {
        return (runId: string, type: string, ...rest: unknown[]) => {
          if (type === BODY_TYPE) {
            reads.bodyReads.push(`readLatestRunEventBefore(${runId}, ${type})`);
          }
          return counted(method.call(target, runId, type, ...rest));
        };
      }
      return method.bind(target);
    },
  });
  return { store: guarded, reads };
};
