import { TOOL_USAGE_WINDOW_RUNS } from '@momonga/memory';
import type { ToolUsageRun } from '@momonga/memory';
import type { RunEvent } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { offeredInBody } from './tool-offer.ts';

const namesOfferedBy = (runId: string, body: unknown): string[] => {
  const { tools, catalog } = offeredInBody(runId, body);
  return [...tools, ...catalog];
};

const offeredBy = (runId: string, events: readonly RunEvent[]): string[] =>
  [...new Set(events.flatMap((event) => (event.type === 'model.requested' ? namesOfferedBy(runId, event.body) : [])))].sort();

export const toolUsageWindowOf = (store: RuntimeStore, project: string): ToolUsageRun[] =>
  store.lastTerminalRootRuns(project, TOOL_USAGE_WINDOW_RUNS).map((run) => ({
    offered: offeredBy(run.id, store.readRunEventsOfTypes(run.id, ['model.requested'])),
    called: store.toolCallNames(run.id),
  }));
