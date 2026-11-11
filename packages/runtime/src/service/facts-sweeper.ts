import type { ReportRecomputePage, RunCallView, RunFactsAnswer, RunFactsView } from '@momonga/protocol';
import { FactsRefusedError, settledEventIdOf } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import type { ServiceTimers } from './timers.ts';

export type FactsSweeperOptions = {
  store: { runFacts: Pick<RuntimeStore['runFacts'], 'nextBatch' | 'commit'> };
  thread: { runFacts(runId: string): Promise<RunFactsAnswer> };
  timers: ServiceTimers;
  intervalMs: number;
  batchSize: number;
  onError: (error: unknown) => void;
};

export const recomputeFactsOf = async (thread: FactsSweeperOptions['thread'], runIds: readonly string[], signal: AbortSignal): Promise<ReportRecomputePage> => {
  const page: ReportRecomputePage = { rows: [], refused: [] };
  for (const runId of runIds) {
    signal.throwIfAborted();
    try {
      const answer = await thread.runFacts(runId);
      if ('facts' in answer) page.rows.push(answer.facts);
    } catch (error) {
      if (!(error instanceof FactsRefusedError)) throw error;
      page.refused.push(runId);
    }
  }
  return page;
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
        const answer = await thread.runFacts(runId);
        if ('skipped' in answer) continue;
        rows.push(answer.facts);
        calls.push(...answer.calls);
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
        else if (processed > 0) store.runFacts.commit({ rows, calls, unavailable, throughEventId: settledEventIdOf(batch, processed) });
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
