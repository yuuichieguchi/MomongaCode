import type { Redactor } from '@momonga/foundation';
import { HISTORY_INDEX_BATCH_CHARS } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import type { ServiceTimers } from './timers.ts';

export const SEARCH_INDEX_BATCH_RUNS = 3;

export type SearchSweeperOptions = {
  store: Pick<RuntimeStore, 'search'>;
  timers: ServiceTimers;
  intervalMs: number;
  batchSize: number;
  redactor: Redactor;
  onError: (error: unknown) => void;
};

export const startSearchSweeper = (options: SearchSweeperOptions): { close(): Promise<void> } => {
  const { store, timers, intervalMs, batchSize, redactor, onError } = options;
  let closed = false;
  let handle: unknown;

  const arm = (): void => {
    handle = timers.setTimeout(sweep, intervalMs);
  };

  function sweep(): void {
    try {
      store.search.indexBatch({ limit: batchSize, redactor, maxChars: HISTORY_INDEX_BATCH_CHARS });
    } catch (error) {
      onError(error);
    }
    if (!closed) arm();
  }

  arm();
  return {
    close: async () => {
      closed = true;
      timers.clearTimeout(handle);
    },
  };
};
