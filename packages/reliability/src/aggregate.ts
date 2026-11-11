import { INDICATOR_DEFINITIONS_VERSION, UNKNOWN_VALUE } from '@momonga/protocol';
import type { GroupKey, IndicatorGroups, Indicators, RunFacts } from './types.ts';

type TaskPartial = {
  root: RunFacts | undefined;
  earliest: RunFacts;
  runIds: readonly string[];
  stale: boolean;
  unknownValues: boolean;
  intervened: boolean;
  sideEffectingCalls: number;
  repeatedStarts: number;
  prevented: number;
  unknown: number;
  recovered: number;
  unknownEffect: number;
  failedEpisodes: number;
  stoppedEpisodes: number;
  durations: number[];
  clockSkew: number;
};

export type Aggregate = { groupBy: GroupKey; tasks: ReadonlyMap<string, TaskPartial>; unavailableRoots: ReadonlySet<string> };

export type AggregateOptions = { groupBy: GroupKey; unavailableRoots?: readonly string[] };

const holdsUnknown = (row: RunFacts): boolean =>
  [row.status, row.stopReason, row.mode, ...row.recoveries.flatMap((episode) => [episode.cause, episode.outcome])].includes(UNKNOWN_VALUE);

const partialOf = (row: RunFacts): TaskPartial => {
  const durations: number[] = [];
  let recovered = 0;
  let unknownEffect = 0;
  let failedEpisodes = 0;
  let stoppedEpisodes = 0;
  let clockSkew = 0;
  for (const episode of row.recoveries) {
    if (episode.outcome === UNKNOWN_VALUE) continue;
    if (episode.outcome === 'unknown_effect') unknownEffect += 1;
    else if (episode.outcome === 'failed') failedEpisodes += 1;
    else if (episode.outcome === 'stopped') stoppedEpisodes += 1;
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
    runIds: [row.runId],
    stale: row.definitionsVersion !== INDICATOR_DEFINITIONS_VERSION,
    unknownValues: holdsUnknown(row),
    intervened: row.asked + row.elicited + row.authorizationRequired > 0,
    sideEffectingCalls: row.sideEffectingCalls,
    repeatedStarts: row.repeatedStarts,
    prevented: row.reconciledAlreadyApplied,
    unknown: row.reconciledUnknown,
    recovered,
    unknownEffect,
    failedEpisodes,
    stoppedEpisodes,
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
    runIds: [...left.runIds, ...right.runIds],
    stale: left.stale || right.stale,
    unknownValues: left.unknownValues || right.unknownValues,
    intervened: left.intervened || right.intervened,
    sideEffectingCalls: left.sideEffectingCalls + right.sideEffectingCalls,
    repeatedStarts: left.repeatedStarts + right.repeatedStarts,
    prevented: left.prevented + right.prevented,
    unknown: left.unknown + right.unknown,
    recovered: left.recovered + right.recovered,
    unknownEffect: left.unknownEffect + right.unknownEffect,
    failedEpisodes: left.failedEpisodes + right.failedEpisodes,
    stoppedEpisodes: left.stoppedEpisodes + right.stoppedEpisodes,
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
  return { groupBy: options.groupBy, tasks, unavailableRoots: new Set(options.unavailableRoots) };
};

export const merge = (left: Aggregate, right: Aggregate): Aggregate => {
  if (left.groupBy !== right.groupBy) throw new RangeError(`cannot merge aggregates grouped by ${left.groupBy} and ${right.groupBy}`);
  const tasks = new Map(left.tasks);
  for (const [rootRunId, partial] of right.tasks) {
    const existing = tasks.get(rootRunId);
    tasks.set(rootRunId, existing === undefined ? partial : combine(existing, partial));
  }
  return { groupBy: left.groupBy, tasks, unavailableRoots: new Set([...left.unavailableRoots, ...right.unavailableRoots]) };
};

export type Period = { days: number; fromMs: number; toMs: number };

export const withinPeriod = (aggregated: Aggregate, period: Period): Aggregate => {
  const outside = new Set<string>();
  for (const [rootRunId, { root }] of aggregated.tasks) {
    if (root !== undefined && (root.endedAt < period.fromMs || root.endedAt > period.toMs)) outside.add(rootRunId);
  }
  return {
    groupBy: aggregated.groupBy,
    tasks: new Map([...aggregated.tasks].filter(([rootRunId]) => !outside.has(rootRunId))),
    unavailableRoots: new Set([...aggregated.unavailableRoots].filter((rootRunId) => !outside.has(rootRunId))),
  };
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
      return row.model;
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
  factsUnavailable: number;
  unknownValues: number;
  completionK: number;
  completionN: number;
  undeclared: number;
  recovered: number;
  unknownEffect: number;
  failedEpisodes: number;
  stoppedEpisodes: number;
  durations: number[];
  clockSkew: number;
  duplicatesK: number;
  duplicatesN: number;
  prevented: number;
  unknown: number;
  interventionK: number;
  overrunK: number;
  overrunN: number;
  moneyOverK: number;
  moneyOverN: number;
  delegation: Indicators['delegation'];
  budgetStops: number;
  timeN: number;
  activeSum: number;
  elapsedSum: number;
};

const emptyAccumulator = (): Accumulator => ({
  counted: 0,
  cancelled: 0,
  pendingFacts: 0,
  factsUnavailable: 0,
  unknownValues: 0,
  completionK: 0,
  completionN: 0,
  undeclared: 0,
  recovered: 0,
  unknownEffect: 0,
  failedEpisodes: 0,
  stoppedEpisodes: 0,
  durations: [],
  clockSkew: 0,
  duplicatesK: 0,
  duplicatesN: 0,
  prevented: 0,
  unknown: 0,
  interventionK: 0,
  overrunK: 0,
  overrunN: 0,
  moneyOverK: 0,
  moneyOverN: 0,
  delegation: { n: 0, intervened: 0, unattended: 0, waited: 0, held: 0, denied: 0 },
  budgetStops: 0,
  timeN: 0,
  activeSum: 0,
  elapsedSum: 0,
});

const SUMMARY_STEP = 1;

const overrunOf = (root: RunFacts): { limited: boolean; over: boolean; money?: boolean } => {
  const { maxSteps, maxTotalTokens, maxCostNano } = root.limits;
  const dimensions: boolean[] = [];
  if (maxTotalTokens !== undefined) dimensions.push(root.tokensTotal > maxTotalTokens);
  const money = maxCostNano === undefined ? undefined : root.costNano > maxCostNano;
  if (money !== undefined) dimensions.push(money);
  if (maxSteps !== undefined) dimensions.push(root.steps > maxSteps + SUMMARY_STEP);
  if (root.deadlineAt !== undefined) dimensions.push(root.endedAt > root.deadlineAt);
  return { limited: dimensions.length > 0, over: dimensions.some(Boolean), ...(money === undefined ? {} : { money }) };
};

export type Marks = Map<string, string[]>;

const markOf = (marks: Marks | undefined, label: string, runId: string): void => {
  if (marks === undefined) return;
  const ids = marks.get(label);
  if (ids === undefined) marks.set(label, [runId]);
  else ids.push(runId);
};

type Excluded = 'pendingFacts' | 'unknownValues' | 'cancelled';

const EXCLUDED_LABELS: Record<Excluded, string> = { pendingFacts: 'pending facts', unknownValues: 'unknown values', cancelled: 'cancelled' };

const exclusionOf = (task: TaskPartial): Excluded | undefined => {
  if (task.root === undefined || task.stale) return 'pendingFacts';
  if (task.unknownValues) return 'unknownValues';
  return task.root.status === 'CANCELLED' ? 'cancelled' : undefined;
};

const accumulate = (accumulator: Accumulator, task: TaskPartial, marks?: Marks): void => {
  const { root } = task;
  const excluded = exclusionOf(task);
  if (root === undefined || excluded !== undefined) {
    if (excluded !== undefined) {
      accumulator[excluded] += 1;
      markOf(marks, EXCLUDED_LABELS[excluded], (root ?? task.earliest).rootRunId);
    }
    return;
  }
  accumulator.counted += 1;
  if (root.declared) {
    accumulator.completionN += 1;
    if (root.met) {
      accumulator.completionK += 1;
      markOf(marks, 'completion met', root.runId);
    } else markOf(marks, 'completion not met', root.runId);
  } else {
    accumulator.undeclared += 1;
    markOf(marks, 'completion undeclared', root.runId);
  }
  if (task.recovered > 0) markOf(marks, 'recovery recovered', root.runId);
  if (task.unknownEffect > 0) markOf(marks, 'recovery unknown_effect', root.runId);
  if (task.failedEpisodes > 0) markOf(marks, 'recovery failed', root.runId);
  if (task.stoppedEpisodes > 0) markOf(marks, 'recovery stopped', root.runId);
  accumulator.recovered += task.recovered;
  accumulator.unknownEffect += task.unknownEffect;
  accumulator.failedEpisodes += task.failedEpisodes;
  accumulator.stoppedEpisodes += task.stoppedEpisodes;
  accumulator.durations.push(...task.durations);
  accumulator.clockSkew += task.clockSkew;
  if (task.sideEffectingCalls > 0) {
    accumulator.duplicatesN += 1;
    if (task.repeatedStarts > 0) {
      accumulator.duplicatesK += 1;
      markOf(marks, 'duplicate side effect (journal)', root.runId);
    }
  }
  accumulator.prevented += task.prevented;
  accumulator.unknown += task.unknown;
  if (task.intervened) {
    accumulator.interventionK += 1;
    markOf(marks, 'human intervention', root.runId);
  }
  const overrun = overrunOf(root);
  if (overrun.limited) {
    accumulator.overrunN += 1;
    if (overrun.over) {
      accumulator.overrunK += 1;
      markOf(marks, 'budget overrun', root.runId);
    }
  }
  if (overrun.money !== undefined) {
    accumulator.moneyOverN += 1;
    if (overrun.money) accumulator.moneyOverK += 1;
  }
  if (root.delegation !== undefined) {
    const { delegation } = accumulator;
    delegation.n += 1;
    delegation.held += root.delegation.held;
    delegation.denied += root.delegation.denied;
    if (root.delegation.resolvedByPerson > 0) delegation.intervened += 1;
    if (root.delegation.waited) delegation.waited += 1;
    if (root.status === 'COMPLETED' && root.delegation.held === 0) delegation.unattended += 1;
  }
  if (root.status === 'STOPPED' && root.stopReason === 'budget') {
    accumulator.budgetStops += 1;
    markOf(marks, 'budget stop', root.runId);
  }
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
    buckets: { counted: accumulator.counted, cancelled: accumulator.cancelled, pendingFacts: accumulator.pendingFacts, factsUnavailable: accumulator.factsUnavailable, unknownValues: accumulator.unknownValues },
    completion: { k: accumulator.completionK, n: accumulator.completionN, undeclared: accumulator.undeclared },
    recovery: {
      k: accumulator.recovered,
      n: episodes,
      unknownEffect: accumulator.unknownEffect,
      failed: accumulator.failedEpisodes,
      stopped: accumulator.stoppedEpisodes,
    },
    recoveryTime: {
      n: sorted.length,
      meanMs: sorted.length === 0 ? null : durationSum / sorted.length,
      medianMs: sorted.length === 0 ? null : medianOf(sorted),
      clockSkew: accumulator.clockSkew,
    },
    duplicates: { journal: { k: accumulator.duplicatesK, n: accumulator.duplicatesN }, prevented: accumulator.prevented, unknown: accumulator.unknown },
    intervention: { k: accumulator.interventionK, n: accumulator.counted },
    overrun: { k: accumulator.overrunK, n: accumulator.overrunN, budgetStops: accumulator.budgetStops, money: { k: accumulator.moneyOverK, n: accumulator.moneyOverN } },
    delegation: { ...accumulator.delegation },
    time: {
      n: accumulator.timeN,
      meanActiveMs: accumulator.timeN === 0 ? null : accumulator.activeSum / accumulator.timeN,
      meanElapsedMs: accumulator.timeN === 0 ? null : accumulator.elapsedSum / accumulator.timeN,
    },
  };
};

const place = (accumulator: Accumulator, rootRunId: string, task: TaskPartial, unavailable: boolean, marks?: Marks): void => {
  if (!unavailable) {
    accumulate(accumulator, task, marks);
    return;
  }
  accumulator.factsUnavailable += 1;
  markOf(marks, 'facts unavailable', rootRunId);
};

export const indicatorsOf = (aggregated: Aggregate): IndicatorGroups => {
  const total = emptyAccumulator();
  const groups = new Map<string, Accumulator>();
  for (const [rootRunId, task] of aggregated.tasks) {
    const unavailable = aggregated.unavailableRoots.has(rootRunId);
    place(total, rootRunId, task, unavailable);
    const key = groupOf(task.root ?? task.earliest, aggregated.groupBy);
    let group = groups.get(key);
    if (group === undefined) {
      group = emptyAccumulator();
      groups.set(key, group);
    }
    place(group, rootRunId, task, unavailable);
  }
  for (const rootRunId of aggregated.unavailableRoots) if (!aggregated.tasks.has(rootRunId)) total.factsUnavailable += 1;
  return {
    total: finish(total),
    groups: Object.fromEntries([...groups.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, group]) => [key, finish(group)])),
  };
};

export const explainOf = (aggregated: Aggregate): Marks => {
  const marks: Marks = new Map();
  const scratch = emptyAccumulator();
  for (const [rootRunId, task] of aggregated.tasks) place(scratch, rootRunId, task, aggregated.unavailableRoots.has(rootRunId), marks);
  for (const rootRunId of aggregated.unavailableRoots) if (!aggregated.tasks.has(rootRunId)) markOf(marks, 'facts unavailable', rootRunId);
  for (const ids of marks.values()) ids.sort();
  return new Map([...marks.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
};

export type CountedTask = { rootRunId: string; group: string; met: boolean; tokens: number; runIds: string[] };

export const countedTasksOf = (aggregated: Aggregate): CountedTask[] => {
  const counted: CountedTask[] = [];
  for (const [rootRunId, task] of aggregated.tasks) {
    const { root } = task;
    if (root === undefined || aggregated.unavailableRoots.has(rootRunId) || exclusionOf(task) !== undefined) continue;
    counted.push({ rootRunId, group: groupOf(root, aggregated.groupBy), met: root.met, tokens: root.tokensTotal, runIds: [...task.runIds].sort() });
  }
  return counted.sort((left, right) => (left.rootRunId < right.rootRunId ? -1 : 1));
};

export const countedRunIdsOf = (aggregated: Aggregate): string[] =>
  countedTasksOf(aggregated)
    .flatMap((task) => task.runIds)
    .sort();
