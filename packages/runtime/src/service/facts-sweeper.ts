import type { RunFactsView } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import type { ServiceTimers } from './timers.ts';

export type FactsSweeperOptions = {
  store: { runFacts: Pick<RuntimeStore['runFacts'], 'nextBatch' | 'commit'> };
  thread: { runFacts(runId: string): Promise<RunFactsView> };
  timers: ServiceTimers;
  intervalMs: number;
  batchSize: number;
  onError: (error: unknown) => void;
};

export const startFactsSweeper = (options: FactsSweeperOptions): { close(): Promise<void> } => {
  const { store, thread, timers, intervalMs, batchSize, onError } = options;
  let closed = false;
  let handle: unknown;
  let running: Promise<void> = Promise.resolve();

  const arm = (): void => {
    handle = timers.setTimeout(() => {
      running = sweep();
    }, intervalMs);
  };

  const factsOfBatch = async (runIds: readonly string[]): Promise<{ rows: RunFactsView[]; unavailable: string[] }> => {
    const rows: RunFactsView[] = [];
    const unavailable: string[] = [];
    for (const runId of runIds) {
      try {
        rows.push(await thread.runFacts(runId));
      } catch (error) {
        unavailable.push(runId);
        onError(error);
      }
    }
    return { rows, unavailable };
  };

  async function sweep(): Promise<void> {
    try {
      const batch = store.runFacts.nextBatch(batchSize);
      if (batch.runIds.length > 0) {
        const { rows, unavailable } = await factsOfBatch(batch.runIds);
        store.runFacts.commit({ rows, unavailable, throughEventId: batch.throughEventId });
      }
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
      await running;
    },
  };
};
