import type { RuntimeStore } from '@momonga/store';
import type { ServiceTimers } from './timers.ts';

export type TerminalSweeperOptions = {
  store: Pick<RuntimeStore, 'finishCancelled' | 'deadLetterExhausted' | 'reaskUnshownApprovals'>;
  timers: ServiceTimers;
  intervalMs: number;
  cancelUpstream?: (runId: string, signal: AbortSignal) => Promise<void>;
  releaseStopped(runId: string, signal: AbortSignal): Promise<void>;
  onError: (error: unknown, runId?: string) => void;
};

export type TerminalSweeper = { sweep(): Promise<void>; close(): Promise<void> };

export const startTerminalSweeper = (options: TerminalSweeperOptions): TerminalSweeper => {
  const { store, timers, intervalMs, cancelUpstream, releaseStopped, onError } = options;
  const closing = new AbortController();
  const releasing = new Set<Promise<void>>();
  const reportRun = (error: unknown, runId: string): void => onError(error, runId);
  let closed = false;
  let handle: unknown;
  let current: Promise<void> = Promise.resolve();

  const track = (runId: string, work: () => Promise<void>): void => {
    const tracked = (async () => work())()
      .catch((error: unknown) => onError(error, runId))
      .finally(() => {
        releasing.delete(tracked);
      });
    releasing.add(tracked);
  };

  const afterCommit = (runId: string): void => {
    if (cancelUpstream !== undefined) track(runId, () => cancelUpstream(runId, closing.signal));
    track(runId, () => releaseStopped(runId, closing.signal));
  };

  const sweepOnce = async (): Promise<void> => {
    try {
      for (const runId of await store.finishCancelled(reportRun)) afterCommit(runId);
      for (const runId of await store.deadLetterExhausted(reportRun)) afterCommit(runId);
      await store.reaskUnshownApprovals(reportRun);
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
      await Promise.all(releasing);
    },
  };
};
