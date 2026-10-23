import type { RuntimeStore } from '@momonga/store';
import type { RunNotifier } from './notifier.ts';
import type { ServiceTimers } from './timers.ts';

export type DataVersionPollOptions = {
  store: Pick<RuntimeStore, 'dataVersion'>;
  notifier: Pick<RunNotifier, 'wakeAll'>;
  timers: ServiceTimers;
  intervalMs: number;
  onError: (error: unknown) => void;
};

export const startDataVersionPoll = (options: DataVersionPollOptions): { close(): void } => {
  const { store, notifier, timers, intervalMs, onError } = options;
  let closed = false;
  let handle: unknown;
  let lastVersion = store.dataVersion();

  const arm = (): void => {
    handle = timers.setTimeout(poll, intervalMs);
  };

  function poll(): void {
    try {
      const version = store.dataVersion();
      if (version !== lastVersion) {
        lastVersion = version;
        notifier.wakeAll();
      }
    } catch (error) {
      onError(error);
    }
    if (!closed) arm();
  }

  arm();
  return {
    close: () => {
      closed = true;
      timers.clearTimeout(handle);
    },
  };
};
