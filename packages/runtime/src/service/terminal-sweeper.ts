import type { RuntimeStore } from '@momonga/store';
import type { ServiceTimers } from './timers.ts';

export type TerminalSweeperOptions = {
  store: Pick<RuntimeStore, 'finishCancelled' | 'deadLetterExhausted'>;
  timers: ServiceTimers;
  intervalMs: number;
  cancelUpstream?: (runId: string) => Promise<void>;
  releaseStopped(runId: string, signal: AbortSignal): Promise<void>;
  onError: (error: unknown) => void;
};

export type TerminalSweeper = { sweep(): Promise<void>; close(): Promise<void> };

export const startTerminalSweeper = (options: TerminalSweeperOptions): TerminalSweeper => {
  const { store, timers, intervalMs, cancelUpstream, releaseStopped, onError } = options;
  const closing = new AbortController();
  const reportRun = (error: unknown): void => onError(error);
  let closed = false;
  let handle: unknown;
  let current: Promise<void> = Promise.resolve();

  const afterCommit = async (runId: string): Promise<void> => {
    try {
      if (cancelUpstream !== undefined) await cancelUpstream(runId);
      await releaseStopped(runId, closing.signal);
    } catch (error) {
      onError(error);
    }
  };

  const sweepOnce = async (): Promise<void> => {
    try {
      for (const runId of await store.finishCancelled(reportRun)) await afterCommit(runId);
      await store.deadLetterExhausted(reportRun);
    } catch (error) {
      onError(error);
    }
  };

  const sweep = (): Promise<void> => {
    current = current.then(sweepOnce);
    return current;
  };

  const arm = (): void => {
    handle = timers.setTimeout(() => {
      void sweep().then(() => {
        if (!closed) arm();
      });
    }, intervalMs);
  };

  arm();
  return {
    sweep,
    close: async () => {
      closed = true;
      timers.clearTimeout(handle);
      closing.abort(new Error('the service is closing'));
      await current;
    },
  };
};
