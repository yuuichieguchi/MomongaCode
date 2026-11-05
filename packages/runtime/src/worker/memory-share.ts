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

const windowRunOf = (store: RuntimeStore, runId: string, events: readonly RunEvent[]): ContributionWindowRun => {
  const items = events.flatMap((event) => (event.type === 'context.contribution' ? event.items : [])).filter((item) => item.kind === 'memory');
  return {
    injected: items.length,
    used: items.filter((item) => item.contributed).length,
    memoriesDropped: store.hasNoticeCode(runId, MEMORIES_DROPPED_CODE),
  };
};

const shareOfParent = (store: RuntimeStore, parentRunId: string): number | undefined =>
  recordedShareOf(parentRunId, store.readRunEventsOfTypes(parentRunId, ['run.started']));

const shareFromWindow = (store: RuntimeStore, project: string): number => {
  const recent = store.lastTerminalRootRuns(project, CONTRIBUTION_WINDOW_RUNS).map((run) => {
    const events = store.readRunEventsOfTypes(run.id, ['run.started', 'context.contribution']);
    return { share: recordedShareOf(run.id, events) ?? DEFAULT_MEMORY_SHARE, window: windowRunOf(store, run.id, events) };
  });
  const previous = recent[0]?.share;
  return nextMemoryShare({ previous, runs: recent.filter((entry) => entry.share === previous).map((entry) => entry.window) });
};

export const memoryShareFor = async (input: { store: RuntimeStore; settings: Pick<SettingsPort, 'context'>; session: Session; run: Run }): Promise<number | undefined> => {
  const { store, settings, session, run } = input;
  if (run.parentRunId !== null) return shareOfParent(store, run.parentRunId);
  if (!(await settings.context(session)).adaptiveBudget) return undefined;
  return shareFromWindow(store, session.cwd);
};
