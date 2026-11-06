import { amountOfUnits } from './cost.ts';
import type { CallBilling, PricedCall } from './cost.ts';
import { CACHE_MISS_CAUSES, RUN_ROLE, escapeTerminalLine } from '@momonga/protocol';
import type { CacheMissCause, PrefixEvent } from '@momonga/protocol';

export type BreakdownAnatomy = {
  layers: Readonly<Record<string, number | Readonly<Record<string, number>> | undefined>>;
};

export type BreakdownPrefix = { broken: false } | { broken: true; causes: readonly PrefixEvent[] };

export type BreakdownCall = {
  runId: string;
  step?: number;
  role?: string;
  provider: string;
  model: string;
  target?: string;
  billing: CallBilling;
  at: Date;
  price: PricedCall;
  anatomy?: BreakdownAnatomy;
  prefix?: BreakdownPrefix;
  usage: { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningTokens: number };
  timing?: { firstEventMs?: number; durationMs: number };
};

export type TimingSummary = { median: number; p95: number; n: number };

export type RoleBreakdown = {
  calls: number;
  timeToFirstToken: TimingSummary | null;
  duration: TimingSummary | null;
  totalDurationMs: number | null;
  timingNotRecorded: number;
};

export type UnpricedCall = { runId: string; provider: string; model: string; step?: number; reason: string };

export type CauseCounts = Partial<Record<CacheMissCause, number>>;

export type CostBreakdown = {
  calls: number;
  layers: { estimated: true; shares: Record<string, number>; tokens: Record<string, number>; callsWithoutAnatomy: number };
  billed: {
    inputTokens: number;
    uncachedInputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  };
  cacheHitRatio: number | null;
  cacheBreaks: CauseCounts;
  cacheMissCauses: CauseCounts;
  timeToFirstToken: TimingSummary | null;
  duration: TimingSummary | null;
  roles: Record<string, RoleBreakdown>;
  cost: { amount: number | null; currency: 'USD'; unpricedCalls: number };
  unpriced: UnpricedCall[];
  inconsistentUsage: UnpricedCall[];
  callsWithoutResponseId: number;
  unjoined: UnjoinedRecord[];
};

export type UnjoinedRecord = { runId: string; step?: number; reason: string };

export type CostBreakdownOptions = { unjoined?: readonly UnjoinedRecord[]; callsWithoutResponseId?: number };

const roleOf = (call: BreakdownCall): string => call.role ?? RUN_ROLE;

const isMain = (call: BreakdownCall): boolean => roleOf(call) === RUN_ROLE;

const countCauses = (causes: readonly CacheMissCause[]): CauseCounts => {
  const counts: CauseCounts = {};
  for (const cause of CACHE_MISS_CAUSES) {
    const count = causes.filter((entry) => entry === cause).length;
    if (count > 0) counts[cause] = count;
  }
  return counts;
};

const breakCausesOf = (prefix: BreakdownPrefix | undefined): CacheMissCause[] => {
  if (prefix === undefined || !prefix.broken) return [];
  return prefix.causes.length === 0 ? ['unexplained'] : [...prefix.causes];
};

const missCausesOf = (calls: readonly BreakdownCall[]): CacheMissCause[] => {
  const misses: CacheMissCause[] = [];
  const runIds = [...new Set(calls.map((call) => call.runId))];
  for (const runId of runIds) {
    const ordered = calls.filter((call) => call.runId === runId).toSorted((left, right) => left.at.getTime() - right.at.getTime());
    let previousMain: BreakdownCall | undefined;
    let sideTargetsSincePreviousMain = new Set<string>();
    for (const call of ordered) {
      if (!isMain(call)) {
        if (call.target !== undefined) sideTargetsSincePreviousMain.add(call.target);
        continue;
      }
      if (call.usage.cachedInputTokens === 0) {
        const [recorded] = breakCausesOf(call.prefix);
        if (recorded !== undefined) misses.push(recorded);
        else if (previousMain !== undefined && previousMain.target !== undefined && call.target !== undefined && previousMain.target !== call.target) misses.push('target_changed');
        else if (previousMain !== undefined && call.target !== undefined && sideTargetsSincePreviousMain.has(call.target)) misses.push('side_call');
        else misses.push('unexplained');
      }
      previousMain = call;
      sideTargetsSincePreviousMain = new Set();
    }
  }
  return misses;
};

const MEDIAN_RANK = 0.5;
const P95_RANK = 0.95;

const nearestRank = (sorted: readonly number[], rank: number): number => sorted[Math.ceil(rank * sorted.length) - 1] as number;

const summarize = (values: readonly number[]): TimingSummary | null => {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  return { median: nearestRank(sorted, MEDIAN_RANK), p95: nearestRank(sorted, P95_RANK), n: sorted.length };
};

const layerEntriesOf = (anatomy: BreakdownAnatomy): [string, number][] =>
  Object.entries(anatomy.layers).flatMap(([name, value]): [string, number][] => {
    if (value === undefined) return [];
    if (typeof value === 'number') return [[name, value]];
    return Object.entries(value).map(([inner, tokens]): [string, number] => [`${name}.${inner}`, tokens]);
  });

export const buildCostBreakdown = (calls: readonly BreakdownCall[], options: CostBreakdownOptions): CostBreakdown => {
  const layerTokens = new Map<string, number>();
  let callsWithoutAnatomy = 0;
  const billed = { inputTokens: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const byRole = new Map<string, { calls: number; firstEvents: number[]; durations: number[]; notRecorded: number }>();
  const unpriced: UnpricedCall[] = [];
  const inconsistentUsage: UnpricedCall[] = [];
  let units = 0n;
  for (const call of calls) {
    if (call.anatomy === undefined) {
      callsWithoutAnatomy += 1;
    } else {
      for (const [name, tokens] of layerEntriesOf(call.anatomy)) layerTokens.set(name, (layerTokens.get(name) ?? 0) + tokens);
    }
    const { usage } = call;
    const identity = { runId: call.runId, provider: call.provider, model: call.model, ...(call.step === undefined ? {} : { step: call.step }) };
    if (usage.cachedInputTokens + usage.cacheWriteInputTokens > usage.inputTokens) {
      inconsistentUsage.push({
        ...identity,
        reason: `cached input (${usage.cachedInputTokens}) and written input (${usage.cacheWriteInputTokens}) together exceed the input (${usage.inputTokens})`,
      });
    } else {
      billed.inputTokens += usage.inputTokens;
      billed.cacheReadTokens += usage.cachedInputTokens;
      billed.cacheWriteTokens += usage.cacheWriteInputTokens;
      billed.uncachedInputTokens += usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens;
    }
    billed.outputTokens += usage.outputTokens;
    billed.reasoningTokens += usage.reasoningTokens;
    const role = roleOf(call);
    const group = byRole.get(role) ?? { calls: 0, firstEvents: [], durations: [], notRecorded: 0 };
    byRole.set(role, group);
    group.calls += 1;
    if (call.timing === undefined) {
      group.notRecorded += 1;
    } else {
      if (call.timing.firstEventMs !== undefined) group.firstEvents.push(call.timing.firstEventMs);
      group.durations.push(call.timing.durationMs);
    }
    const priced = call.price;
    if (priced.kind === 'unpriced') {
      unpriced.push({ ...identity, reason: priced.reason });
      continue;
    }
    units += priced.units;
  }
  const roles: Record<string, RoleBreakdown> = Object.fromEntries(
    [...byRole].map(([role, group]) => [
      role,
      {
        calls: group.calls,
        timeToFirstToken: summarize(group.firstEvents),
        duration: summarize(group.durations),
        totalDurationMs: group.durations.length === 0 ? null : group.durations.reduce((sum, value) => sum + value, 0),
        timingNotRecorded: group.notRecorded,
      },
    ]),
  );
  const main = roles[RUN_ROLE];
  const layerTotal = [...layerTokens.values()].reduce((sum, tokens) => sum + tokens, 0);
  return {
    calls: calls.length,
    layers: {
      estimated: true,
      shares: layerTotal === 0 ? {} : Object.fromEntries([...layerTokens].map(([name, tokens]) => [name, tokens / layerTotal])),
      tokens: Object.fromEntries(layerTokens),
      callsWithoutAnatomy,
    },
    billed,
    cacheHitRatio: billed.inputTokens === 0 || inconsistentUsage.length > 0 ? null : billed.cacheReadTokens / billed.inputTokens,
    cacheBreaks: countCauses(calls.filter(isMain).flatMap((call) => breakCausesOf(call.prefix))),
    cacheMissCauses: countCauses(missCausesOf(calls)),
    timeToFirstToken: main?.timeToFirstToken ?? null,
    duration: main?.duration ?? null,
    roles,
    cost: { amount: unpriced.length === 0 ? amountOfUnits(units) : null, currency: 'USD', unpricedCalls: unpriced.length },
    unpriced,
    inconsistentUsage,
    callsWithoutResponseId: options.callsWithoutResponseId ?? 0,
    unjoined: [...(options.unjoined ?? [])],
  };
};

const percent = (share: number): string => `${(share * 100).toFixed(1)}%`;

const roleLine = (role: string, entry: RoleBreakdown): string => {
  const total = entry.totalDurationMs === null ? 'not recorded' : `${entry.totalDurationMs} ms`;
  const notRecorded = entry.timingNotRecorded === 0 ? '' : `; ${entry.timingNotRecorded} call(s) with no timing recorded`;
  return `role ${role}: ${entry.calls} call(s), total duration ${total}, ${timingLine('time to first token', entry.timeToFirstToken)}, ${timingLine('duration', entry.duration)}${notRecorded}`;
};

const timingLine = (label: string, summary: TimingSummary | null): string =>
  summary === null ? `${label}: not recorded` : `${label}: median ${summary.median} ms, p95 ${summary.p95} ms (n=${summary.n})`;

const causeLine = (label: string, counts: CauseCounts): string[] => {
  const entries = CACHE_MISS_CAUSES.flatMap((cause) => (counts[cause] === undefined ? [] : [`${cause} ${counts[cause]}`]));
  return entries.length === 0 ? [] : [`${label}: ${entries.join(', ')}`];
};

export const formatCostBreakdown = (breakdown: CostBreakdown): string => {
  const { billed } = breakdown;
  const shares = Object.entries(breakdown.layers.shares).filter(([, tokens]) => tokens > 0);
  const layerLine =
    shares.length === 0
      ? 'layers (estimated): not recorded'
      : `layers (estimated): ${shares.map(([name, share]) => `${name} ${percent(share)}`).join(', ')}`;
  const withoutAnatomy =
    breakdown.layers.callsWithoutAnatomy === 0 ? '' : `, ${breakdown.layers.callsWithoutAnatomy} of ${breakdown.calls} call(s) have no recorded layers`;
  const cost =
    breakdown.cost.amount === null
      ? `cost: unknown (${breakdown.cost.unpricedCalls} of ${breakdown.calls} call(s) have no price)`
      : `cost: ${breakdown.cost.amount} ${breakdown.cost.currency}`;
  return [
    `calls: ${breakdown.calls}`,
    `${layerLine}${withoutAnatomy}`,
    ...(breakdown.inconsistentUsage.length === 0
      ? []
      : [`billed tokens by kind are incomplete: ${breakdown.inconsistentUsage.length} of ${breakdown.calls} call(s) report more cached and written input than input and are excluded from the input figures`]),
    `billed tokens: input ${billed.inputTokens} = uncached ${billed.uncachedInputTokens} + cache read ${billed.cacheReadTokens} + cache write ${billed.cacheWriteTokens}; output ${billed.outputTokens} (reasoning ${billed.reasoningTokens})`,
    breakdown.cacheHitRatio === null ? `cache hit ratio: none (${breakdown.inconsistentUsage.length > 0 ? 'a call has inconsistent usage' : 'no input'})` : `cache hit ratio: ${percent(breakdown.cacheHitRatio)}`,
    ...causeLine('cache breaks by cause', breakdown.cacheBreaks),
    ...causeLine('cache-miss causes', breakdown.cacheMissCauses),
    timingLine('time to first token', breakdown.timeToFirstToken),
    timingLine('duration', breakdown.duration),
    ...Object.entries(breakdown.roles).map(([role, entry]) => roleLine(role, entry)),
    ...(breakdown.callsWithoutResponseId === 0
      ? []
      : [`${breakdown.callsWithoutResponseId} calls recorded before response ids: layers and timing not recorded`]),
    cost,
    ...breakdown.unpriced.map(
      (entry) => `unpriced: ${entry.provider}/${entry.model} (run ${entry.runId}${entry.step === undefined ? '' : `, step ${entry.step}`}): ${entry.reason}`,
    ),
    ...breakdown.inconsistentUsage.map(
      (entry) => `inconsistent usage: ${entry.provider}/${entry.model} (run ${entry.runId}${entry.step === undefined ? '' : `, step ${entry.step}`}): ${entry.reason}`,
    ),
    ...breakdown.unjoined.map((entry) => `unjoined: run ${entry.runId}${entry.step === undefined ? '' : `, step ${entry.step}`}: ${entry.reason}`),
  ]
    .map(escapeTerminalLine)
    .join('\n');
};
