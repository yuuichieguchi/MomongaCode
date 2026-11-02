import { foldRunState, initialRunState } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import type { ToolRuntimePort } from '../ports.ts';
import { releaseWaitingCalls } from '../worker/release-waiting.ts';

export const createStoppedRunReleaser =
  ({ store, tools }: { store: Pick<RuntimeStore, 'getRun' | 'getSession' | 'load'>; tools: Pick<ToolRuntimePort, 'envFor' | 'toolSet' | 'executor'> }) =>
  async (runId: string, signal: AbortSignal): Promise<void> => {
    const run = store.getRun(runId);
    if (run === undefined) throw new Error(`unknown run ${runId}`);
    const session = store.getSession(run.sessionId);
    if (session === undefined) throw new Error(`unknown session ${run.sessionId}`);
    const loaded = store.load(runId);
    const state = loaded.tail.reduce(foldRunState, loaded.snapshot?.state ?? initialRunState({ runId, sessionId: run.sessionId }));
    await releaseWaitingCalls({ tools, run, session, pendingCalls: state.pendingCalls, signal });
  };
