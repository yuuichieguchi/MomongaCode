import { TOOL_USAGE_WINDOW_RUNS } from '@momonga/memory';
import type { ToolUsageRun } from '@momonga/memory';
import type { RuntimeStore } from '@momonga/store';

export const toolUsageWindowOf = (store: RuntimeStore, project: string): ToolUsageRun[] =>
  store.lastTerminalRootRuns(project, TOOL_USAGE_WINDOW_RUNS).map((run) => ({
    offered: store.toolOfferedNames(run.id),
    called: store.toolCallNames(run.id),
  }));
