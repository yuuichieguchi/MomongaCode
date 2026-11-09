import { TOOL_USAGE_WINDOW_RUNS } from '@momonga/memory';
import type { ToolUsageRun } from '@momonga/memory';
import type { RuntimeStore } from '@momonga/store';

export const toolUsageWindowOf = async (store: RuntimeStore, project: string): Promise<ToolUsageRun[]> => {
  const runs: ToolUsageRun[] = [];
  for (const run of store.lastTerminalRootRuns(project, TOOL_USAGE_WINDOW_RUNS)) runs.push({ offered: store.toolOfferedNames(run.id), called: await store.toolCallNames(run.id) });
  return runs;
};
