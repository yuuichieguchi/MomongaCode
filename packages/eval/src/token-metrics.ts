import { USAGE_CHARGE_PURPOSES, anatomyLayerEntries, reportedCachedTokensOf } from '@momonga/protocol';
import type { ModelCost, PublicRunEvent, UnpricedCode, UnpricedOutcome, UsageChargePurpose } from '@momonga/protocol';
import { ratioBootstrap } from './bootstrap.ts';
import type { Cluster } from './bootstrap.ts';
import { eventsOfType } from './observe.ts';
import { EvalError } from './runner.ts';
import type { TranscriptReflection } from './transcript.ts';

export type CallKind = 'run' | 'reflection' | UsageChargePurpose;

export type CallFacts = {
  kind: CallKind;
  inputTokens: number;
  cachedInputTokens: number | undefined;
  cacheWriteInputTokens: number;
  cost: number | undefined;
  unpriced: UnpricedCode | undefined;
  durationMs: number | undefined;
};

const priceFactsOf = (record: { cost?: ModelCost; unpriced?: UnpricedOutcome } | undefined): Pick<CallFacts, 'cost' | 'unpriced'> => ({
  cost: record?.cost?.amount,
  unpriced: record?.unpriced?.code,
});

export type TokenFacts = {
  calls: CallFacts[];
  layers: Map<string, number>;
  anatomyTotal: number;
  unsettledReflections: number;
};

export type ReflectionColumn = { calls?: number; inputTokens?: number; cost?: number; settled: boolean };

export type CaseTokenTotals = {
  reflection: ReflectionColumn;
  calls: number;
  unsettledReflections: number;
  cacheReadNotReportedCalls: number;
  inputTokens?: number;
  cacheReportedInputTokens?: number;
  cachedInputTokens?: number;
  uncachedInputTokens?: number;
  cost?: number;
  unpriced?: Partial<Record<UnpricedCode, number>>;
  unrecordedPrice?: number;
  latencyMs?: number;
};

export type RatioMetric = { value: number; numerator: number; denominator: number; low: number; high: number; clusters: number };

export const PER_SUCCESS_METRICS = ['costPerSuccess', 'uncachedInputPerSuccess', 'callsPerSuccess', 'latencyPerSuccess'] as const;
export type PerSuccessMetric = (typeof PER_SUCCESS_METRICS)[number];

export type TokenMetrics = {
  costPerSuccess: RatioMetric | undefined;
  uncachedInputPerSuccess: RatioMetric | undefined;
  callsPerSuccess: RatioMetric | undefined;
  latencyPerSuccess: RatioMetric | undefined;
  cacheHitRatio: RatioMetric | undefined;
  layerShares: Record<string, RatioMetric> | undefined;
  reflectionCostPerSuccess: RatioMetric | undefined;
  reflectionCallsPerSuccess: RatioMetric | undefined;
  costPerSuccessAll: RatioMetric | undefined;
};

const reflectionCallsOf = (reflection: TranscriptReflection | undefined): { calls: CallFacts[]; unsettled: boolean } => {
  if (reflection === undefined) return { calls: [], unsettled: true };
  const { state, charges = [] } = reflection;
  return {
    unsettled: state === 'pending' || state === 'running',
    calls: charges.map(
      (charge): CallFacts => ({
        kind: 'reflection',
        inputTokens: charge.inputTokens,
        cachedInputTokens: charge.detail?.cachedInputTokens,
        cacheWriteInputTokens: charge.detail?.cacheWriteInputTokens ?? 0,
        ...priceFactsOf(charge.detail),
        durationMs: charge.detail?.timing?.durationMs,
      }),
    ),
  };
};

const isChargePurpose = (purpose: string): purpose is UsageChargePurpose => (USAGE_CHARGE_PURPOSES as readonly string[]).includes(purpose);

const chargePurposeOf = (purpose: string): UsageChargePurpose => {
  if (!isChargePurpose(purpose)) throw new EvalError(`a usage.charged event has the purpose ${JSON.stringify(purpose)}, which is none of ${USAGE_CHARGE_PURPOSES.join(', ')}`);
  return purpose;
};

export const tokenFactsOf = (runs: readonly (readonly PublicRunEvent[])[], reflection: TranscriptReflection | undefined): TokenFacts => {
  const layers = new Map<string, number>();
  let anatomyTotal = 0;
  const calls = runs.flatMap((events) => {
    for (const requested of eventsOfType(events, 'model.requested')) {
      if (requested.anatomy === undefined) continue;
      anatomyTotal += requested.anatomy.total;
      for (const [name, tokens] of anatomyLayerEntries(requested.anatomy.layers)) layers.set(name, (layers.get(name) ?? 0) + tokens);
    }
    const responded = eventsOfType(events, 'model.responded').map(({ response }): CallFacts => ({
      kind: 'run',
      inputTokens: response.usage.input_tokens,
      cachedInputTokens: reportedCachedTokensOf(response.usage, response.momonga),
      cacheWriteInputTokens: response.momonga?.cacheWriteInputTokens ?? 0,
      ...priceFactsOf(response.momonga),
      durationMs: response.timing?.durationMs,
    }));
    const charged = eventsOfType(events, 'usage.charged').map(
      (event): CallFacts => ({
        kind: chargePurposeOf(event.purpose),
        inputTokens: event.inputTokens,
        cachedInputTokens: event.cachedInputTokens,
        cacheWriteInputTokens: event.cacheWriteInputTokens ?? 0,
        ...priceFactsOf(event),
        durationMs: event.timing?.durationMs,
      }),
    );
    return [...responded, ...charged];
  });
  const settled = reflectionCallsOf(reflection);
  return { calls: [...calls, ...settled.calls], layers, anatomyTotal, unsettledReflections: settled.unsettled ? 1 : 0 };
};

const sumOver = <T>(items: readonly T[], pick: (item: T) => number | undefined): number | undefined => {
  let sum = 0;
  for (const item of items) {
    const value = pick(item);
    if (value === undefined) return undefined;
    sum += value;
  }
  return sum;
};

type ReportedCall = CallFacts & { cachedInputTokens: number };

const isCacheReadReported = (call: CallFacts): call is ReportedCall => call.cachedInputTokens !== undefined;

const isConsistent = (call: ReportedCall): boolean => call.cachedInputTokens + call.cacheWriteInputTokens <= call.inputTokens;

const cacheFiguresOf = (calls: readonly CallFacts[]): Pick<CaseTokenTotals, 'cacheReportedInputTokens' | 'cachedInputTokens' | 'uncachedInputTokens'> => {
  const reported = calls.filter(isCacheReadReported);
  if (!reported.every(isConsistent) || (calls.length > 0 && reported.length === 0)) return {};
  const sum = (pick: (call: ReportedCall) => number): number => reported.reduce((total, call) => total + pick(call), 0);
  return {
    cacheReportedInputTokens: sum((call) => call.inputTokens),
    cachedInputTokens: sum((call) => call.cachedInputTokens),
    uncachedInputTokens: sum((call) => call.inputTokens - call.cachedInputTokens - call.cacheWriteInputTokens),
  };
};

const priceOutcomeTotalsOf = (calls: readonly CallFacts[]): Pick<CaseTokenTotals, 'unpriced' | 'unrecordedPrice'> => {
  const unpriced: Partial<Record<UnpricedCode, number>> = {};
  let unrecordedPrice = 0;
  for (const call of calls) {
    if (call.unpriced !== undefined) unpriced[call.unpriced] = (unpriced[call.unpriced] ?? 0) + 1;
    else if (call.cost === undefined) unrecordedPrice += 1;
  }
  return { ...(Object.keys(unpriced).length === 0 ? {} : { unpriced }), ...(unrecordedPrice === 0 ? {} : { unrecordedPrice }) };
};

const reflectionColumnOf = (calls: readonly CallFacts[], settled: boolean): ReflectionColumn => {
  if (!settled) return { settled };
  const cost = sumOver(calls, (call) => call.cost);
  return { calls: calls.length, inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0), ...(cost === undefined ? {} : { cost }), settled };
};

export const caseTotalsOf = (facts: readonly TokenFacts[]): CaseTokenTotals => {
  const every = facts.flatMap((entry) => entry.calls);
  const calls = every.filter((call) => call.kind !== 'reflection');
  const unsettledReflections = facts.reduce((sum, entry) => sum + entry.unsettledReflections, 0);
  const inputTokens = sumOver(calls, (call) => call.inputTokens);
  const cost = sumOver(calls, (call) => call.cost);
  const latencyMs = sumOver(calls, (call) => call.durationMs);
  return {
    reflection: reflectionColumnOf(
      every.filter((call) => call.kind === 'reflection'),
      unsettledReflections === 0,
    ),
    calls: calls.length,
    unsettledReflections,
    cacheReadNotReportedCalls: calls.length - calls.filter(isCacheReadReported).length,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...cacheFiguresOf(calls),
    ...(cost === undefined ? {} : { cost }),
    ...priceOutcomeTotalsOf(calls),
    ...(latencyMs === undefined ? {} : { latencyMs }),
  };
};

export const hasInconsistentCacheRead = (totals: CaseTokenTotals): boolean =>
  totals.calls > totals.cacheReadNotReportedCalls && totals.cachedInputTokens === undefined;

export const uncachedInputOf = (totals: Omit<CaseTokenTotals, 'reflection'>): number | undefined =>
  totals.cacheReadNotReportedCalls === 0 ? totals.uncachedInputTokens : undefined;

export type CaseForMetrics = { totals: CaseTokenTotals; passedRuns: number; facts: readonly TokenFacts[] };

const ratioOf = (clusters: readonly Cluster[], seed: number): RatioMetric | undefined => {
  const interval = ratioBootstrap(clusters, { seed });
  if (interval === undefined) return undefined;
  return {
    value: interval.value,
    numerator: clusters.reduce((sum, cluster) => sum + cluster.numerator, 0),
    denominator: clusters.reduce((sum, cluster) => sum + cluster.denominator, 0),
    low: interval.low,
    high: interval.high,
    clusters: interval.clusters,
  };
};

const perSuccess = (cases: readonly CaseForMetrics[], numeratorOf: (totals: CaseTokenTotals) => number | undefined, seed: number): RatioMetric | undefined => {
  if (cases.every((entry) => entry.totals.calls === 0)) return undefined;
  return ratioPerSuccess(cases, numeratorOf, seed);
};

const ratioPerSuccess = (cases: readonly CaseForMetrics[], numeratorOf: (totals: CaseTokenTotals) => number | undefined, seed: number): RatioMetric | undefined => {
  const clusters: Cluster[] = [];
  for (const entry of cases) {
    const numerator = numeratorOf(entry.totals);
    if (numerator === undefined) return undefined;
    clusters.push({ numerator, denominator: entry.passedRuns });
  }
  return clusters.length === 0 ? undefined : ratioOf(clusters, seed);
};

const cacheHitRatioOf = (cases: readonly CaseForMetrics[], seed: number): RatioMetric | undefined => {
  const clusters: Cluster[] = [];
  for (const entry of cases) {
    const { cacheReportedInputTokens, cachedInputTokens } = entry.totals;
    if (hasInconsistentCacheRead(entry.totals)) return undefined;
    if (cacheReportedInputTokens === undefined || cachedInputTokens === undefined) continue;
    if (cacheReportedInputTokens > 0) clusters.push({ numerator: cachedInputTokens, denominator: cacheReportedInputTokens });
  }
  return clusters.length === 0 ? undefined : ratioOf(clusters, seed);
};

const layerSharesOf = (cases: readonly CaseForMetrics[], seed: number): Record<string, RatioMetric> | undefined => {
  const names = [...new Set(cases.flatMap((entry) => entry.facts.flatMap((facts) => [...facts.layers.keys()])))];
  const shares = names.flatMap((name): [string, RatioMetric][] => {
    const clusters = cases.map((entry) => ({
      numerator: entry.facts.reduce((sum, facts) => sum + (facts.layers.get(name) ?? 0), 0),
      denominator: entry.facts.reduce((sum, facts) => sum + facts.anatomyTotal, 0),
    }));
    const metric = ratioOf(clusters, seed);
    return metric === undefined || metric.numerator === 0 ? [] : [[name, metric]];
  });
  return shares.length === 0 ? undefined : Object.fromEntries(shares);
};

export const tokenMetricsOf = (cases: readonly CaseForMetrics[], seed: number): TokenMetrics => ({
  costPerSuccess: perSuccess(cases, (totals) => totals.cost, seed),
  uncachedInputPerSuccess: perSuccess(cases, uncachedInputOf, seed),
  callsPerSuccess: perSuccess(cases, (totals) => totals.calls, seed),
  latencyPerSuccess: perSuccess(cases, (totals) => totals.latencyMs, seed),
  cacheHitRatio: cacheHitRatioOf(cases, seed),
  layerShares: layerSharesOf(cases, seed),
  reflectionCostPerSuccess: ratioPerSuccess(cases, (totals) => totals.reflection.cost, seed),
  reflectionCallsPerSuccess: ratioPerSuccess(cases, (totals) => totals.reflection.calls, seed),
  costPerSuccessAll: perSuccess(cases, (totals) => (totals.cost === undefined || totals.reflection.cost === undefined ? undefined : totals.cost + totals.reflection.cost), seed),
});
