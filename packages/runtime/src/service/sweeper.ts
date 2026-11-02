import type { Clock } from '@momonga/foundation';
import type { RuntimeStore } from '@momonga/store';
import type { ServiceTimers } from './timers.ts';

export type ApprovalSweeperOptions = {
  store: Pick<RuntimeStore, 'expireApprovals'>;
  clock: Clock;
  timers: ServiceTimers;
  intervalMs: number;
  releaseStopped(runId: string, signal: AbortSignal): Promise<void>;
  onError: (error: unknown) => void;
};

export const startApprovalSweeper = (options: ApprovalSweeperOptions): { close(): Promise<void> } => {
  const { store, clock, timers, intervalMs, releaseStopped, onError } = options;
  const closing = new AbortController();
  const releasing = new Set<Promise<void>>();
  let closed = false;
  let handle: unknown;

  const release = (runId: string): void => {
    const tracked = releaseStopped(runId, closing.signal)
      .catch(onError)
      .finally(() => {
        releasing.delete(tracked);
      });
    releasing.add(tracked);
  };

  const arm = (): void => {
    handle = timers.setTimeout(sweep, intervalMs);
  };

  function sweep(): void {
    try {
      for (const runId of store.expireApprovals(clock.now())) release(runId);
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
      closing.abort(new Error('the service is closing'));
      await Promise.all(releasing);
    },
  };
};
