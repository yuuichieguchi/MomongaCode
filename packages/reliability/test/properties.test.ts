import { describe, expect, it } from 'vitest';
import { INDICATOR_DEFINITIONS_VERSION, RECOVERY_OUTCOMES } from '@momonga/protocol';
import type { PermissionMode, RunEvent, RunEventPayload, RunStatus, SideEffect } from '@momonga/protocol';
import { aggregate, foldFacts, indicatorsOf, merge } from '@momonga/reliability';
import type { GroupKey, Indicators, RunFacts, RunInfo } from '@momonga/reliability';
import {
  T0,
  attemptFailed,
  eventsOf,
  messageDelta,
  modelRequested,
  permissionClassifiedAllow,
  permissionRequested,
  reconciled,
  runInfo,
  started,
  status,
  terminal,
  thoughtDelta,
  toolCall,
  toolCompleted,
  toolStarted,
} from './streams.ts';
import type { Timed } from './streams.ts';

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
const TASKS_PER_SEED = 40;

const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;

type Outcome = (typeof RECOVERY_OUTCOMES)[number];

type EpisodeTruth = { outcome: Outcome; skew: boolean };

type RunTruth = {
  episodes: EpisodeTruth[];
  asked: boolean;
  sideEffecting: boolean;
  repeated: boolean;
  prevented: number;
  unknown: number;
  failedByEpisode: boolean;
};

type TaskTruth = {
  rootId: string;
  counted: boolean;
  cancelled: boolean;
  stale: boolean;
  declared: boolean;
  met: boolean;
  overrun: boolean;
  budgetStopWithoutOvershoot: boolean;
  runs: RunTruth[];
};

type Generated = { tasks: TaskTruth[]; rows: RunFacts[]; streams: Map<string, { events: RunEvent[]; info: RunInfo }> };

const MODELS = ['fm', 'gpt-x', 'sonnet'];
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'bypassPermissions'];
const AGENTS = ['build', 'review'];
const ORIGINS = ['cli', 'api'];

const generateRun = (random: () => number, startAt: number, declared: boolean, modelAlias: string, mode: PermissionMode) => {
  const timed: Timed[] = [];
  let t = startAt;
  const push = (payload: RunEventPayload): number => {
    t += 10;
    timed.push([t, payload]);
    return t;
  };
  const truth: RunTruth = { episodes: [], asked: false, sideEffecting: false, repeated: false, prevented: 0, unknown: 0, failedByEpisode: false };
  timed.push([startAt, started(1, { declared, modelAlias, mode })]);
  if (random() < 0.5) push(messageDelta(`assistant says ${Math.floor(random() * 1e6)}`));
  if (random() < 0.3) push(thoughtDelta(`thinking ${Math.floor(random() * 1e6)}`));
  const calls = Math.floor(random() * 4);
  const open: string[] = [];
  for (let index = 0; index < calls; index += 1) {
    const callId = `c${index}`;
    const sideEffect: SideEffect = pick(random, ['read_only', 'write', 'exec']);
    if (sideEffect !== 'read_only') truth.sideEffecting = true;
    push(toolCall(callId, sideEffect));
    if (random() < 0.3) {
      push(permissionRequested(callId));
      truth.asked = true;
    } else if (random() < 0.3) {
      push(permissionClassifiedAllow(callId));
    }
    push(toolStarted(callId));
    if (sideEffect !== 'read_only' && random() < 0.2) {
      push(toolStarted(callId));
      truth.repeated = true;
    }
    if (index === calls - 1 && random() < 0.6) open.push(callId);
    else push(toolCompleted(callId));
  }
  let attempt = 1;
  const crashes = random() < 0.5 ? 0 : 1 + Math.floor(random() * 2);
  for (let crash = 0; crash < crashes && !truth.failedByEpisode; crash += 1) {
    const last = crash === crashes - 1;
    let failedAt: number;
    let cause: 'worker_failure' | 'process_lost';
    if (random() < 0.5) {
      failedAt = push(attemptFailed(attempt, 'gateway_unavailable'));
      push(status('RUNNING', 'QUEUED'));
      cause = 'worker_failure';
    } else {
      failedAt = t + 5;
      cause = 'process_lost';
    }
    const skew = random() < 0.15;
    if (skew) failedAt = t + 100_000;
    attempt += 1;
    push(started(attempt, { recovery: { cause, failedAt }, declared, modelAlias, mode }));
    if (!last && random() < 0.5) {
      truth.episodes.push({ outcome: 'failed', skew: false });
      continue;
    }
    if (random() < 0.15) {
      push(terminal('FAILED'));
      truth.episodes.push({ outcome: 'failed', skew: false });
      truth.failedByEpisode = true;
      break;
    }
    let anyUnknown = false;
    for (const callId of open.splice(0)) {
      const outcome = pick(random, ['already_applied', 'not_applied', 'unknown'] as const);
      if (outcome === 'already_applied') truth.prevented += 1;
      if (outcome === 'unknown') {
        truth.unknown += 1;
        anyUnknown = true;
      }
      push(reconciled(callId, outcome));
    }
    push(modelRequested(attempt));
    truth.episodes.push({ outcome: anyUnknown ? 'unknown_effect' : 'recovered', skew: !anyUnknown && skew });
  }
  if (!truth.failedByEpisode && random() < 0.3) {
    push(status('RUNNING', 'WAITING_HUMAN'));
    push(status('WAITING_HUMAN', 'RUNNING'));
  }
  return { timed, truth, end: () => t, push };
};

const generate = (seed: number): Generated => {
  const random = seededRandom(seed);
  const tasks: TaskTruth[] = [];
  const rows: RunFacts[] = [];
  const streams = new Map<string, { events: RunEvent[]; info: RunInfo }>();
  for (let index = 0; index < TASKS_PER_SEED; index += 1) {
    const rootId = `s${seed}-t${index}`;
    const declared = random() < 0.6;
    const modelAlias = pick(random, MODELS);
    const mode = pick(random, MODES);
    const agent = pick(random, AGENTS);
    const origin = pick(random, ORIGINS);
    const startAt = T0 + index * 1_000_000;
    const root = generateRun(random, startAt, declared, modelAlias, mode);
    let finalStatus: RunStatus;
    let stopReason: RunInfo['stopReason'];
    if (root.truth.failedByEpisode) finalStatus = 'FAILED';
    else {
      finalStatus = pick(random, ['COMPLETED', 'COMPLETED', 'COMPLETED', 'FAILED', 'STOPPED', 'CANCELLED'] as const);
      if (finalStatus === 'STOPPED' && random() < 0.7) stopReason = 'budget';
      root.push(terminal(finalStatus));
    }
    const endAt = root.end();
    const dimension = pick(random, ['none', 'tokens', 'steps', 'deadline'] as const);
    let limits: RunInfo['limits'] = {};
    let tokensTotal = 500;
    let step = 3;
    let deadlineAt: number | undefined;
    let overrun = false;
    if (dimension === 'tokens') {
      tokensTotal = pick(random, [900, 1000, 1001, 1500]);
      limits = { maxTotalTokens: 1000 };
      overrun = tokensTotal > 1000;
    } else if (dimension === 'steps') {
      step = pick(random, [10, 11, 12]);
      limits = { maxSteps: 10 };
      overrun = step > 11;
    } else if (dimension === 'deadline') {
      deadlineAt = endAt + pick(random, [-1, 0, 1]);
      overrun = endAt > deadlineAt;
    }
    const cancelled = finalStatus === 'CANCELLED';
    const stale = !cancelled && random() < 0.1;
    const shared = { rootRunId: rootId, modelAlias, mode, agent, origin, createdAt: startAt };
    const rootInfo = runInfo({
      ...shared,
      runId: rootId,
      status: finalStatus,
      ...(stopReason === undefined ? {} : { stopReason }),
      limits,
      ...(deadlineAt === undefined ? {} : { deadlineAt }),
      step,
      tokensTotal,
    });
    const runTruths = [root.truth];
    const rootEvents = eventsOf(rootId, root.timed);
    streams.set(rootId, { events: rootEvents, info: rootInfo });
    const taskRows = [foldFacts(rootEvents, rootInfo)];
    if (random() < 0.3) {
      const childId = `${rootId}-child`;
      const child = generateRun(random, startAt + 1, false, modelAlias, mode);
      const childStatus: RunStatus = child.truth.failedByEpisode ? 'FAILED' : 'COMPLETED';
      if (!child.truth.failedByEpisode) child.push(terminal('COMPLETED'));
      const childInfo = runInfo({ ...shared, runId: childId, createdAt: startAt + 1, status: childStatus, limits: {}, step: 1, tokensTotal: 0 });
      const childEvents = eventsOf(childId, child.timed);
      streams.set(childId, { events: childEvents, info: childInfo });
      taskRows.push(foldFacts(childEvents, childInfo));
      runTruths.push(child.truth);
    }
    rows.push(...taskRows.map((row) => (stale ? { ...row, definitionsVersion: INDICATOR_DEFINITIONS_VERSION - 1 } : row)));
    tasks.push({
      rootId,
      counted: !cancelled && !stale,
      cancelled,
      stale,
      declared,
      met: finalStatus === 'COMPLETED',
      overrun,
      budgetStopWithoutOvershoot: stopReason === 'budget' && !overrun,
      runs: runTruths,
    });
  }
  return { tasks, rows, streams };
};

const shuffled = <T>(random: () => number, items: readonly T[]): T[] => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
};

const GROUP_KEYS: GroupKey[] = ['model', 'mode', 'agent', 'origin'];

const COUNT_PATHS: ((indicators: Indicators) => number)[] = [
  (i) => i.buckets.counted,
  (i) => i.buckets.cancelled,
  (i) => i.buckets.pendingFacts,
  (i) => i.completion.k,
  (i) => i.completion.n,
  (i) => i.completion.undeclared,
  (i) => i.recovery.k,
  (i) => i.recovery.n,
  (i) => i.recovery.unknownEffect,
  (i) => i.recovery.failed,
  (i) => i.recoveryTime.n,
  (i) => i.recoveryTime.clockSkew,
  (i) => i.duplicates.journal.k,
  (i) => i.duplicates.journal.n,
  (i) => i.duplicates.prevented,
  (i) => i.duplicates.unknown,
  (i) => i.intervention.k,
  (i) => i.intervention.n,
  (i) => i.overrun.k,
  (i) => i.overrun.n,
  (i) => i.overrun.budgetStops,
  (i) => i.time.n,
];

const countedTasks = (generated: Generated): TaskTruth[] => generated.tasks.filter((task) => task.counted);

describe('properties of foldFacts and aggregate on generated streams', () => {
  it('P1 monoid: merging the aggregates of any split, in any order, equals the aggregate of the whole', () => {
    for (const seed of SEEDS) {
      const generated = generate(seed);
      const random = seededRandom(seed * 7919);
      for (const groupBy of GROUP_KEYS) {
        const whole = indicatorsOf(aggregate(generated.rows, { groupBy }));
        const order = shuffled(random, generated.rows);
        const cuts = [0, ...Array.from({ length: 1 + Math.floor(random() * 4) }, () => Math.floor(random() * order.length)).sort((a, b) => a - b), order.length];
        const parts = cuts.slice(1).map((end, index) => aggregate(order.slice(cuts[index], end), { groupBy }));
        const merged = shuffled(random, parts).reduce((left, right) => merge(left, right));
        expect(indicatorsOf(merged), `seed ${seed} groupBy ${groupBy}`).toEqual(whole);
      }
    }
  });

  it('P3 partition and subset: numerators within denominators, each task counted once, groups sum to the total', () => {
    for (const seed of SEEDS) {
      const generated = generate(seed);
      for (const groupBy of GROUP_KEYS) {
        const { total, groups } = indicatorsOf(aggregate(generated.rows, { groupBy }));
        const message = `seed ${seed} groupBy ${groupBy}`;
        for (const rate of [total.completion, total.recovery, total.duplicates.journal, total.intervention, total.overrun]) {
          expect(rate.k, message).toBeLessThanOrEqual(rate.n);
        }
        expect(total.intervention.n, message).toBe(total.buckets.counted);
        expect(total.completion.n + total.completion.undeclared, message).toBe(total.buckets.counted);
        expect(total.duplicates.journal.n, message).toBeLessThanOrEqual(total.buckets.counted);
        expect(total.overrun.n, message).toBeLessThanOrEqual(total.buckets.counted);
        expect(total.recovery.k + total.recovery.unknownEffect + total.recovery.failed, message).toBe(total.recovery.n);
        for (const path of COUNT_PATHS) {
          const summed = Object.values(groups).reduce((sum, group) => sum + path(group), 0);
          expect(summed, `${message} ${path.toString()}`).toBe(path(total));
        }
      }
    }
  });

  it('P3 and P15 against the generator: every terminal root is in exactly one bucket and the counts are the hand-known ones', () => {
    for (const seed of SEEDS) {
      const generated = generate(seed);
      const { total } = indicatorsOf(aggregate(generated.rows, { groupBy: 'model' }));
      const counted = countedTasks(generated);
      const message = `seed ${seed}`;
      expect(total.buckets, message).toEqual({
        counted: counted.length,
        cancelled: generated.tasks.filter((task) => task.cancelled).length,
        pendingFacts: generated.tasks.filter((task) => task.stale).length,
      });
      expect(total.buckets.counted + total.buckets.cancelled + total.buckets.pendingFacts, message).toBe(TASKS_PER_SEED);
      expect(total.completion, message).toEqual({
        k: counted.filter((task) => task.declared && task.met).length,
        n: counted.filter((task) => task.declared).length,
        undeclared: counted.filter((task) => !task.declared).length,
      });
      expect(total.intervention, message).toEqual({ k: counted.filter((task) => task.runs.some((run) => run.asked)).length, n: counted.length });
      expect(total.duplicates, message).toEqual({
        journal: {
          k: counted.filter((task) => task.runs.some((run) => run.repeated)).length,
          n: counted.filter((task) => task.runs.some((run) => run.sideEffecting)).length,
        },
        prevented: counted.reduce((sum, task) => sum + task.runs.reduce((runs, run) => runs + run.prevented, 0), 0),
        unknown: counted.reduce((sum, task) => sum + task.runs.reduce((runs, run) => runs + run.unknown, 0), 0),
      });
    }
  });

  it('P4 no self-report: replacing every assistant text and renaming every model alias changes no indicator, only the group names', () => {
    const rename = (alias: string): string => `renamed-${alias.split('').reverse().join('')}`;
    const rewrite = (event: RunEvent): RunEvent => {
      if (event.type === 'agent.message.delta' || event.type === 'agent.thought.delta') return { ...event, text: 'I completed the task and every test passed.' };
      if (event.type === 'run.started') return { ...event, pins: { ...event.pins, modelAlias: rename(String(event.pins['modelAlias'])) } };
      return event;
    };
    for (const seed of SEEDS) {
      const generated = generate(seed);
      const rewritten = generated.rows.map((row) => {
        const stream = generated.streams.get(row.runId);
        if (stream === undefined) throw new Error(`no stream for ${row.runId}`);
        const facts = foldFacts(stream.events.map(rewrite), { ...stream.info, modelAlias: rename(stream.info.modelAlias) });
        return row.definitionsVersion === INDICATOR_DEFINITIONS_VERSION ? facts : { ...facts, definitionsVersion: row.definitionsVersion };
      });
      for (const groupBy of GROUP_KEYS) {
        const before = indicatorsOf(aggregate(generated.rows, { groupBy }));
        const after = indicatorsOf(aggregate(rewritten, { groupBy }));
        expect(after.total, `seed ${seed} groupBy ${groupBy}`).toEqual(before.total);
        const renamedGroups = groupBy === 'model' ? Object.fromEntries(Object.entries(before.groups).map(([key, value]) => [rename(key), value])) : before.groups;
        expect(after.groups, `seed ${seed} groupBy ${groupBy}`).toEqual(renamedGroups);
      }
    }
  });

  it('P5 episodes: one per run.started carrying recovery, each with exactly one outcome, and the outcomes add up', () => {
    for (const seed of SEEDS) {
      const generated = generate(seed);
      for (const row of generated.rows) {
        const stream = generated.streams.get(row.runId);
        const withRecovery = (stream?.events ?? []).filter((event) => event.type === 'run.started' && 'recovery' in event && event.recovery !== undefined);
        expect(row.recoveries, `seed ${seed} run ${row.runId}`).toHaveLength(withRecovery.length);
        for (const episode of row.recoveries) expect(RECOVERY_OUTCOMES, `seed ${seed} run ${row.runId}`).toContain(episode.outcome);
      }
      for (const task of generated.tasks) {
        const rows = generated.rows.filter((row) => row.rootRunId === task.rootId);
        expect(
          rows.flatMap((row) => row.recoveries.map((episode) => episode.outcome)),
          `seed ${seed} task ${task.rootId}`,
        ).toEqual(task.runs.flatMap((run) => run.episodes.map((episode) => episode.outcome)));
      }
      const episodes = countedTasks(generated).flatMap((task) => task.runs.flatMap((run) => run.episodes));
      const { recovery } = indicatorsOf(aggregate(generated.rows, { groupBy: 'model' })).total;
      expect(recovery, `seed ${seed}`).toEqual({
        k: episodes.filter((episode) => episode.outcome === 'recovered').length,
        n: episodes.length,
        unknownEffect: episodes.filter((episode) => episode.outcome === 'unknown_effect').length,
        failed: episodes.filter((episode) => episode.outcome === 'failed').length,
      });
    }
  });

  it('P6 time: a recovered episode with progress before failedAt is clock_skew and out of the mean', () => {
    for (const seed of SEEDS) {
      const generated = generate(seed);
      for (const row of generated.rows) {
        for (const episode of row.recoveries.filter((candidate) => candidate.outcome === 'recovered')) {
          expect(episode.progressAt, `seed ${seed} run ${row.runId}`).toEqual(expect.any(Number));
        }
      }
      const recovered = countedTasks(generated).flatMap((task) => task.runs.flatMap((run) => run.episodes)).filter((episode) => episode.outcome === 'recovered');
      const { recoveryTime } = indicatorsOf(aggregate(generated.rows, { groupBy: 'model' })).total;
      expect(recoveryTime.n, `seed ${seed}`).toBe(recovered.filter((episode) => !episode.skew).length);
      expect(recoveryTime.clockSkew, `seed ${seed}`).toBe(recovered.filter((episode) => episode.skew).length);
      if (recoveryTime.n > 0) expect(recoveryTime.meanMs, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      else expect(recoveryTime.meanMs, `seed ${seed}`).toBeNull();
    }
  });

  it('P7 overrun: only consumption past a limit counts; a budget stop alone never does', () => {
    let budgetStopsWithoutOvershoot = 0;
    for (const seed of SEEDS) {
      const generated = generate(seed);
      const counted = countedTasks(generated);
      budgetStopsWithoutOvershoot += counted.filter((task) => task.budgetStopWithoutOvershoot).length;
      const { overrun } = indicatorsOf(aggregate(generated.rows, { groupBy: 'model' })).total;
      expect(overrun.k, `seed ${seed}`).toBe(counted.filter((task) => task.overrun).length);
    }
    expect(budgetStopsWithoutOvershoot).toBeGreaterThan(0);
  });
});
