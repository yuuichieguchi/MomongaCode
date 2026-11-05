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

export type StoppedRunReleaseOptions = {
  store: Pick<RuntimeStore, 'terminalRunIdsWithCheckpoint'>;
  releaseStopped(runId: string, signal: AbortSignal): Promise<void>;
  signal: AbortSignal;
  onError: (error: unknown) => void;
};

export const releaseStoppedRunsAtStartup = async ({ store, releaseStopped, signal, onError }: StoppedRunReleaseOptions): Promise<void> => {
  let runIds: string[];
  try {
    runIds = store.terminalRunIdsWithCheckpoint();
  } catch (error) {
    onError(error);
    return;
  }
  for (const runId of runIds) {
    if (signal.aborted) return;
    await releaseStopped(runId, signal).catch(onError);
  }
};

export const startApprovalSweeper = (options: ApprovalSweeperOptions): { close(): Promise<void> } => {
  const { store, clock, timers, intervalMs, releaseStopped, onError } = options;
  const closing = new AbortController();
  const releasing = new Set<Promise<void>>();
  let closed = false;
  let handle: unknown;
  let sweeping: Promise<void> = Promise.resolve();

  const release = (runId: string): void => {
    const tracked = releaseStopped(runId, closing.signal)
      .catch(onError)
      .finally(() => {
        releasing.delete(tracked);
      });
    releasing.add(tracked);
  };

  const sweepOnce = async (): Promise<void> => {
    try {
      for (const runId of await store.expireApprovals(clock.now(), (error) => onError(error))) release(runId);
    } catch (error) {
      onError(error);
    }
  };

  const arm = (): void => {
    handle = timers.setTimeout(() => {
      sweeping = sweepOnce().then(() => {
        if (!closed) arm();
      });
    }, intervalMs);
  };

  arm();
  return {
    close: async () => {
      closed = true;
      timers.clearTimeout(handle);
      closing.abort(new Error('the service is closing'));
      await sweeping;
      await Promise.all(releasing);
    },
  };
};
