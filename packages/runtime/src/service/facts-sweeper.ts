import type { RunCallView, RunFactsRecord, RunFactsView } from '@momonga/protocol';
import { FactsRefusedError } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import type { ServiceTimers } from './timers.ts';

export type FactsSweeperOptions = {
  store: { runFacts: Pick<RuntimeStore['runFacts'], 'nextBatch' | 'commit'> };
  thread: { runFacts(runId: string): Promise<RunFactsRecord> };
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

  const factsOfBatch = async (runIds: readonly string[]): Promise<{ rows: RunFactsView[]; calls: RunCallView[]; unavailable: string[]; processed: number }> => {
    const rows: RunFactsView[] = [];
    const calls: RunCallView[] = [];
    const unavailable: string[] = [];
    for (const [index, runId] of runIds.entries()) {
      try {
        const record = await thread.runFacts(runId);
        rows.push(record.facts);
        calls.push(...record.calls);
      } catch (error) {
        onError(error);
        if (!(error instanceof FactsRefusedError)) return { rows, calls, unavailable, processed: index };
        unavailable.push(runId);
      }
    }
    return { rows, calls, unavailable, processed: runIds.length };
  };

  async function sweep(): Promise<void> {
    try {
      const batch = store.runFacts.nextBatch(batchSize);
      if (batch.runIds.length > 0) {
        const { rows, calls, unavailable, processed } = await factsOfBatch(batch.runIds);
        if (processed === batch.runIds.length) store.runFacts.commit({ rows, calls, unavailable, throughEventId: batch.throughEventId });
        else if (processed > 0) store.runFacts.commit({ rows, calls, unavailable, throughEventId: store.runFacts.nextBatch(processed).throughEventId });
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
