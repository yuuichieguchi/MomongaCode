import { CONTRIBUTION_WINDOW_RUNS } from './memory-share.ts';

export const TOOL_USAGE_WINDOW_RUNS = CONTRIBUTION_WINDOW_RUNS;

export type ToolUsageRun = { offered: readonly string[]; called: readonly string[] };

export const deferredSetOf = (input: { runs: readonly ToolUsageRun[]; windowRuns?: number }): string[] => {
  const windowRuns = input.windowRuns ?? TOOL_USAGE_WINDOW_RUNS;
  if (input.runs.length < windowRuns) return [];
  const window = input.runs.slice(0, windowRuns);
  const called = new Set(window.flatMap((run) => run.called));
  const offeredByAll = window.map((run) => new Set(run.offered));
  const candidates = new Set(window.flatMap((run) => run.offered));
  return [...candidates].filter((name) => !called.has(name) && offeredByAll.every((offered) => offered.has(name))).sort();
};
