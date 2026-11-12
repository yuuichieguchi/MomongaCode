import type { Clock } from '@momonga/foundation';
import type { RuntimeStore } from '@momonga/store';
import { beginUpkeepPass, runMemoryUpkeep } from './upkeep.ts';
import type { MemoryUpkeepOptions, MemoryUpkeepResult, UpkeepPass } from './upkeep.ts';

export type MemoryUpkeepScheduleOptions = {
  store: Pick<RuntimeStore, 'memories'>;
  clock: Clock;
  fileSystem: MemoryUpkeepOptions['fileSystem'];
  views: MemoryUpkeepOptions['views'];
  forgetAfterDays: MemoryUpkeepOptions['forgetAfterDays'];
  batchSize: number;
  pageRows: number;
  passIntervalMs: number;
  onSkipped(project: string): void;
};

export type MemoryUpkeepSchedule = { tick(signal: AbortSignal): Promise<MemoryUpkeepResult | undefined> };

export const createMemoryUpkeepSchedule = (options: MemoryUpkeepScheduleOptions): MemoryUpkeepSchedule => {
  const { store, clock } = options;
  let pass: UpkeepPass | undefined;
  let lastPassAt: number | undefined;
  let expected = store.memories.revision();
  let dirty = true;
  return {
    tick: async (signal) => {
      const revision = store.memories.revision();
      if (revision !== expected) {
        dirty = true;
        expected = revision;
      }
      const now = clock.now();
      if (pass === undefined) {
        if (!dirty && lastPassAt !== undefined && now - lastPassAt < options.passIntervalMs) return undefined;
        dirty = false;
        lastPassAt = now;
        pass = beginUpkeepPass(store);
      }
      let result: MemoryUpkeepResult;
      try {
        result = await runMemoryUpkeep({ store, clock, fileSystem: options.fileSystem, views: options.views, forgetAfterDays: options.forgetAfterDays, batchSize: options.batchSize, pageRows: options.pageRows, pass, signal });
      } catch (error) {
        dirty = true;
        expected = store.memories.revision();
        throw error;
      }
      expected += result.duplicates + result.archived;
      for (const project of result.skipped) options.onSkipped(project);
      if (result.done) pass = undefined;
      return result;
    },
  };
};
