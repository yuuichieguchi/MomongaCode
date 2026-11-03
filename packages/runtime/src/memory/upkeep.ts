import { archivableIds, duplicateMarks, isIdleBeyondWindow } from '@momonga/memory';
import type { Clock } from '@momonga/foundation';
import type { MemoryRecord } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import type { RecordViews } from './views.ts';

export type MemoryUpkeepOptions = {
  store: Pick<RuntimeStore, 'memories'>;
  clock: Clock;
  views: RecordViews;
  forgetAfterDays(project: string | null): Promise<number>;
  batchSize: number;
  signal: AbortSignal;
};

export type MemoryUpkeepResult = { duplicates: number; archived: number };

export const runMemoryUpkeep = async (options: MemoryUpkeepOptions): Promise<MemoryUpkeepResult> => {
  const { store, clock, views, batchSize, signal } = options;
  const live = store.memories.live();
  const marks = duplicateMarks(live).slice(0, batchSize);
  for (const mark of marks) store.memories.markDuplicate(mark.id, mark.duplicateOf);
  const marked = new Set(marks.map((mark) => mark.id));
  const groups = new Map<string | null, MemoryRecord[]>();
  for (const record of live.filter((entry) => !marked.has(entry.id))) {
    groups.set(record.project, [...(groups.get(record.project) ?? []), record]);
  }
  let archived = 0;
  const failures: unknown[] = [];
  for (const [project, group] of groups) {
    signal.throwIfAborted();
    if (marks.length + archived >= batchSize) break;
    try {
      const window = { now: clock.now(), forgetAfterDays: await options.forgetAfterDays(project) };
      const idle = group.filter((record) => isIdleBeyondWindow(record, window));
      if (idle.length === 0) continue;
      const ids = archivableIds(await views.viewsOf(idle, signal), window).slice(0, batchSize - marks.length - archived);
      for (const id of ids) store.memories.archive(id);
      archived += ids.length;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `memory upkeep failed for ${failures.length} projects`);
  return { duplicates: marks.length, archived };
};
