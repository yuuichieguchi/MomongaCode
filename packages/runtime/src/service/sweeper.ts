import type { Clock } from '@momonga/foundation';
import type { RuntimeStore } from '@momonga/store';
import type { ServiceTimers } from './timers.ts';

export type ApprovalSweeperOptions = {
  store: Pick<RuntimeStore, 'expireApprovals'>;
  clock: Clock;
  timers: ServiceTimers;
  intervalMs: number;
  onError: (error: unknown) => void;
};

export const startApprovalSweeper = (options: ApprovalSweeperOptions): { close(): void } => {
  const { store, clock, timers, intervalMs, onError } = options;
  let closed = false;
  let handle: unknown;

  const arm = (): void => {
    handle = timers.setTimeout(sweep, intervalMs);
  };

  function sweep(): void {
    try {
      store.expireApprovals(clock.now());
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
