import { CONTRIBUTION_WINDOW_RUNS, DEFAULT_MEMORY_SHARE, nextMemoryShare } from '@momonga/memory';
import type { ContributionWindowRun } from '@momonga/memory';
import type { RunEvent } from '@momonga/protocol';
import type { Run, RuntimeStore, Session } from '@momonga/store';
import type { SettingsPort } from '../ports.ts';

const SHARE_PIN = 'memoryShare';
const MEMORIES_DROPPED_CODE = 'memories_dropped';

const recordedShareOf = (runId: string, events: readonly RunEvent[]): number | undefined => {
  const started = events.find((event) => event.type === 'run.started');
  if (started?.type !== 'run.started') throw new Error(`run ${runId} has no run.started event`);
  const share = started.pins[SHARE_PIN];
  if (share !== undefined && typeof share !== 'number') throw new Error(`the memory share pinned by run ${runId} is not a number`);
  return share;
};

const windowRunOf = async (store: RuntimeStore, runId: string, events: readonly RunEvent[]): Promise<ContributionWindowRun> => {
  const injectedIds = new Set(events.flatMap((event) => (event.type === 'context.memories_loaded' ? event.memories.map((memory) => memory.id) : [])));
  const items = events.flatMap((event) => (event.type === 'context.contribution' ? event.items : [])).filter((item) => item.kind === 'memory' && injectedIds.has(item.id));
  return {
    injected: items.length,
    used: items.filter((item) => item.contributed).length,
    memoriesDropped: await store.hasNoticeCode(runId, MEMORIES_DROPPED_CODE),
  };
};

const shareOfParent = (store: RuntimeStore, parentRunId: string): number | undefined =>
  recordedShareOf(parentRunId, store.readRunEventsOfTypes(parentRunId, ['run.started']));

const shareFromWindow = async (store: RuntimeStore, project: string): Promise<number> => {
  const recent: { share: number; window: ContributionWindowRun }[] = [];
  for (const run of store.lastTerminalRootRuns(project, CONTRIBUTION_WINDOW_RUNS)) {
    const events = store.readRunEventsOfTypes(run.id, ['run.started', 'context.contribution', 'context.memories_loaded']);
    recent.push({ share: recordedShareOf(run.id, events) ?? DEFAULT_MEMORY_SHARE, window: await windowRunOf(store, run.id, events) });
  }
  const previous = recent[0]?.share;
  return nextMemoryShare({ previous, runs: recent.filter((entry) => entry.share === previous).map((entry) => entry.window) });
};

export const memoryShareFor = async (input: { store: RuntimeStore; settings: Pick<SettingsPort, 'context'>; session: Session; run: Run; signal: AbortSignal }): Promise<number | undefined> => {
  const { store, settings, session, run, signal } = input;
  if (run.parentRunId !== null) return shareOfParent(store, run.parentRunId);
  if (!(await settings.context(session, signal)).adaptiveBudget) return undefined;
  return shareFromWindow(store, session.cwd);
};
