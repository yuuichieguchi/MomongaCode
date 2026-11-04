import { TOOL_USAGE_WINDOW_RUNS } from '@momonga/memory';
import type { ToolUsageRun } from '@momonga/memory';
import type { RunEvent } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { isRecord } from './json.ts';

const toolNamesOf = (runId: string, body: unknown): string[] => {
  if (!isRecord(body) || !Array.isArray(body['tools'])) throw new Error(`a model.requested event of run ${runId} holds a body without a tools list`);
  return body['tools'].map((tool) => {
    if (!isRecord(tool) || typeof tool['name'] !== 'string') throw new Error(`a model.requested event of run ${runId} lists a tool without a name`);
    return tool['name'];
  });
};

const offeredBy = (runId: string, events: readonly RunEvent[]): string[] =>
  [...new Set(events.flatMap((event) => (event.type === 'model.requested' ? toolNamesOf(runId, event.body) : [])))].sort();

export const toolUsageWindowOf = (store: RuntimeStore, project: string): ToolUsageRun[] =>
  store.lastTerminalRootRuns(project, TOOL_USAGE_WINDOW_RUNS).map((run) => ({
    offered: offeredBy(run.id, store.readRunEventsOfTypes(run.id, ['model.requested'])),
    called: store.toolCallNames(run.id),
  }));
