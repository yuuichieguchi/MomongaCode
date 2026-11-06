import { INDICATOR_DEFINITIONS_VERSION } from '@momonga/protocol';
import type { GroupKey, IndicatorGroups, Indicators, RunFacts } from './types.ts';

type TaskPartial = {
  root: RunFacts | undefined;
  earliest: RunFacts;
  stale: boolean;
  intervened: boolean;
  sideEffectingCalls: number;
  repeatedStarts: number;
  prevented: number;
  unknown: number;
  recovered: number;
  unknownEffect: number;
  failedEpisodes: number;
  durations: number[];
  clockSkew: number;
};

export type Aggregate = { groupBy: GroupKey; tasks: ReadonlyMap<string, TaskPartial> };

export type AggregateOptions = { groupBy: GroupKey };

const partialOf = (row: RunFacts): TaskPartial => {
  const durations: number[] = [];
  let recovered = 0;
  let unknownEffect = 0;
  let failedEpisodes = 0;
  let clockSkew = 0;
  for (const episode of row.recoveries) {
    if (episode.outcome === 'unknown_effect') unknownEffect += 1;
    else if (episode.outcome === 'failed') failedEpisodes += 1;
    else {
      recovered += 1;
      if (episode.progressAt === null) throw new RangeError(`run ${row.runId}: a recovered episode has no progress instant`);
      const duration = episode.progressAt - episode.failedAt;
      if (duration < 0) clockSkew += 1;
      else durations.push(duration);
    }
  }
  return {
    root: row.runId === row.rootRunId ? row : undefined,
    earliest: row,
    stale: row.definitionsVersion !== INDICATOR_DEFINITIONS_VERSION,
    intervened: row.asked + row.elicited + row.authorizationRequired > 0,
    sideEffectingCalls: row.sideEffectingCalls,
    repeatedStarts: row.repeatedStarts,
    prevented: row.reconciledAlreadyApplied,
    unknown: row.reconciledUnknown,
    recovered,
    unknownEffect,
    failedEpisodes,
    durations,
    clockSkew,
  };
};

const combine = (left: TaskPartial, right: TaskPartial): TaskPartial => {
  if (left.root !== undefined && right.root !== undefined) {
    throw new RangeError(`task ${left.root.rootRunId} has two root rows`);
  }
  return {
    root: left.root ?? right.root,
    earliest: left.earliest.runId <= right.earliest.runId ? left.earliest : right.earliest,
    stale: left.stale || right.stale,
    intervened: left.intervened || right.intervened,
    sideEffectingCalls: left.sideEffectingCalls + right.sideEffectingCalls,
    repeatedStarts: left.repeatedStarts + right.repeatedStarts,
    prevented: left.prevented + right.prevented,
    unknown: left.unknown + right.unknown,
    recovered: left.recovered + right.recovered,
    unknownEffect: left.unknownEffect + right.unknownEffect,
    failedEpisodes: left.failedEpisodes + right.failedEpisodes,
    durations: [...left.durations, ...right.durations],
    clockSkew: left.clockSkew + right.clockSkew,
  };
};

const addRows = (tasks: Map<string, TaskPartial>, rows: readonly RunFacts[]): void => {
  for (const row of rows) {
    const existing = tasks.get(row.rootRunId);
    const partial = partialOf(row);
    tasks.set(row.rootRunId, existing === undefined ? partial : combine(existing, partial));
  }
};

export const aggregate = (rows: readonly RunFacts[], options: AggregateOptions): Aggregate => {
  const tasks = new Map<string, TaskPartial>();
  addRows(tasks, rows);
  return { groupBy: options.groupBy, tasks };
};

export const merge = (left: Aggregate, right: Aggregate): Aggregate => {
  if (left.groupBy !== right.groupBy) throw new RangeError(`cannot merge aggregates grouped by ${left.groupBy} and ${right.groupBy}`);
  const tasks = new Map(left.tasks);
  for (const [rootRunId, partial] of right.tasks) {
    const existing = tasks.get(rootRunId);
    tasks.set(rootRunId, existing === undefined ? partial : combine(existing, partial));
  }
  return { groupBy: left.groupBy, tasks };
};

const DAY_MS = 86_400_000;
const MONDAY_OFFSET_DAYS = 3;
const WEEK_DAYS = 7;

const weekOf = (ms: number): string => {
  const day = Math.floor(ms / DAY_MS);
  const weekStart = day - ((day + MONDAY_OFFSET_DAYS) % WEEK_DAYS);
  return new Date(weekStart * DAY_MS).toISOString().slice(0, 10);
};

const groupOf = (row: RunFacts, groupBy: GroupKey): string => {
  switch (groupBy) {
    case 'model':
      return row.modelAlias;
    case 'mode':
      return row.mode;
    case 'agent':
      return row.agent;
    case 'origin':
      return row.origin;
    case 'period':
      return weekOf(row.endedAt);
  }
};

type Accumulator = {
  counted: number;
  cancelled: number;
  pendingFacts: number;
  completionK: number;
  completionN: number;
  undeclared: number;
  recovered: number;
  unknownEffect: number;
  failedEpisodes: number;
  durations: number[];
  clockSkew: number;
  duplicatesK: number;
  duplicatesN: number;
  prevented: number;
  unknown: number;
  interventionK: number;
  overrunK: number;
  overrunN: number;
  budgetStops: number;
  timeN: number;
  activeSum: number;
  elapsedSum: number;
};

const emptyAccumulator = (): Accumulator => ({
  counted: 0,
  cancelled: 0,
  pendingFacts: 0,
  completionK: 0,
  completionN: 0,
  undeclared: 0,
  recovered: 0,
  unknownEffect: 0,
  failedEpisodes: 0,
  durations: [],
  clockSkew: 0,
  duplicatesK: 0,
  duplicatesN: 0,
  prevented: 0,
  unknown: 0,
  interventionK: 0,
  overrunK: 0,
  overrunN: 0,
  budgetStops: 0,
  timeN: 0,
  activeSum: 0,
  elapsedSum: 0,
});

const SUMMARY_STEP = 1;

const overrunOf = (root: RunFacts): { limited: boolean; over: boolean } => {
  const { maxSteps, maxTotalTokens } = root.limits;
  const dimensions: boolean[] = [];
  if (maxTotalTokens !== undefined) dimensions.push(root.tokensTotal > maxTotalTokens);
  if (maxSteps !== undefined) dimensions.push(root.steps > maxSteps + SUMMARY_STEP);
  if (root.deadlineAt !== undefined) dimensions.push(root.endedAt > root.deadlineAt);
  return { limited: dimensions.length > 0, over: dimensions.some(Boolean) };
};

const accumulate = (accumulator: Accumulator, task: TaskPartial): void => {
  const { root } = task;
  if (root === undefined || task.stale) {
    accumulator.pendingFacts += 1;
    return;
  }
  if (root.status === 'CANCELLED') {
    accumulator.cancelled += 1;
    return;
  }
  accumulator.counted += 1;
  if (root.declared) {
    accumulator.completionN += 1;
    if (root.met) accumulator.completionK += 1;
  } else accumulator.undeclared += 1;
  accumulator.recovered += task.recovered;
  accumulator.unknownEffect += task.unknownEffect;
  accumulator.failedEpisodes += task.failedEpisodes;
  accumulator.durations.push(...task.durations);
  accumulator.clockSkew += task.clockSkew;
  if (task.sideEffectingCalls > 0) {
    accumulator.duplicatesN += 1;
    if (task.repeatedStarts > 0) accumulator.duplicatesK += 1;
  }
  accumulator.prevented += task.prevented;
  accumulator.unknown += task.unknown;
  if (task.intervened) accumulator.interventionK += 1;
  const overrun = overrunOf(root);
  if (overrun.limited) {
    accumulator.overrunN += 1;
    if (overrun.over) accumulator.overrunK += 1;
  }
  if (root.status === 'STOPPED' && root.stopReason === 'budget') accumulator.budgetStops += 1;
  if (root.met) {
    accumulator.timeN += 1;
    accumulator.activeSum += root.elapsedMs - root.humanWaitMs;
    accumulator.elapsedSum += root.elapsedMs;
  }
};

const medianOf = (sorted: readonly number[]): number => {
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] as number;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] as number) + upper) / 2;
};

const finish = (accumulator: Accumulator): Indicators => {
  const sorted = [...accumulator.durations].sort((left, right) => left - right);
  const durationSum = sorted.reduce((sum, value) => sum + value, 0);
  const episodes = accumulator.recovered + accumulator.unknownEffect + accumulator.failedEpisodes;
  return {
    buckets: { counted: accumulator.counted, cancelled: accumulator.cancelled, pendingFacts: accumulator.pendingFacts },
    completion: { k: accumulator.completionK, n: accumulator.completionN, undeclared: accumulator.undeclared },
    recovery: { k: accumulator.recovered, n: episodes, unknownEffect: accumulator.unknownEffect, failed: accumulator.failedEpisodes },
    recoveryTime: {
      n: sorted.length,
      meanMs: sorted.length === 0 ? null : durationSum / sorted.length,
      medianMs: sorted.length === 0 ? null : medianOf(sorted),
      clockSkew: accumulator.clockSkew,
    },
    duplicates: { journal: { k: accumulator.duplicatesK, n: accumulator.duplicatesN }, prevented: accumulator.prevented, unknown: accumulator.unknown },
    intervention: { k: accumulator.interventionK, n: accumulator.counted },
    overrun: { k: accumulator.overrunK, n: accumulator.overrunN, budgetStops: accumulator.budgetStops },
    time: {
      n: accumulator.timeN,
      meanActiveMs: accumulator.timeN === 0 ? null : accumulator.activeSum / accumulator.timeN,
      meanElapsedMs: accumulator.timeN === 0 ? null : accumulator.elapsedSum / accumulator.timeN,
    },
  };
};

export const indicatorsOf = (aggregated: Aggregate): IndicatorGroups => {
  const total = emptyAccumulator();
  const groups = new Map<string, Accumulator>();
  for (const task of aggregated.tasks.values()) {
    accumulate(total, task);
    const key = groupOf(task.root ?? task.earliest, aggregated.groupBy);
    let group = groups.get(key);
    if (group === undefined) {
      group = emptyAccumulator();
      groups.set(key, group);
    }
    accumulate(group, task);
  }
  return {
    total: finish(total),
    groups: Object.fromEntries([...groups.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, group]) => [key, finish(group)])),
  };
};
