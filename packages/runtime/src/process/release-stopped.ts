import type { RuntimeStore } from '@momonga/store';
import type { ToolRuntimePort } from '../ports.ts';
import { releaseCalls } from '../worker/release-waiting.ts';

export const createStoppedRunReleaser =
  ({ store, tools }: { store: Pick<RuntimeStore, 'getRun' | 'getSession' | 'startedCallsOf'>; tools: Pick<ToolRuntimePort, 'envFor' | 'toolSet' | 'executor'> }) =>
  async (runId: string, signal: AbortSignal): Promise<void> => {
    const run = store.getRun(runId);
    if (run === undefined) throw new Error(`unknown run ${runId}`);
    const session = store.getSession(run.sessionId);
    if (session === undefined) throw new Error(`unknown session ${run.sessionId}`);
    await releaseCalls({ tools, run, session, targets: await store.startedCallsOf(runId), signal });
  };
