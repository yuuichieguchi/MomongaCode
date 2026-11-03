import { anatomyLayerEntries } from '@momonga/protocol';
import type { PublicRunEvent } from '@momonga/protocol';
import { ratioBootstrap } from './bootstrap.ts';
import type { Cluster } from './bootstrap.ts';
import { eventsOfType } from './observe.ts';
import type { TranscriptReflection } from './transcript.ts';

export type CallFacts = {
  inputTokens: number;
  cachedInputTokens: number | undefined;
  cacheWriteInputTokens: number;
  cost: number | undefined;
  durationMs: number | undefined;
};

export type TokenFacts = {
  calls: CallFacts[];
  layers: Map<string, number>;
  anatomyTotal: number;
  unsettledReflections: number;
};

export type CaseTokenTotals = {
  calls: number;
  unsettledReflections: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  uncachedInputTokens?: number;
  cost?: number;
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
};

const reflectionCallOf = (reflection: TranscriptReflection | undefined): { call?: CallFacts; unsettled: boolean } => {
  if (reflection === undefined) return { unsettled: true };
  const { state, charge } = reflection;
  if (state === 'pending' || state === 'running') return { unsettled: true };
  if (charge === undefined) return { unsettled: state === 'done' };
  return {
    unsettled: false,
    call: {
      inputTokens: charge.inputTokens,
      cachedInputTokens: charge.detail?.cachedInputTokens,
      cacheWriteInputTokens: charge.detail?.cacheWriteInputTokens ?? 0,
      cost: charge.detail?.cost?.amount,
      durationMs: charge.detail?.timing?.durationMs,
    },
  };
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
      inputTokens: response.usage.input_tokens,
      cachedInputTokens: response.usage.input_tokens_details?.cached_tokens,
      cacheWriteInputTokens: response.momonga?.cacheWriteInputTokens ?? 0,
      cost: response.momonga?.cost?.amount,
      durationMs: response.timing?.durationMs,
    }));
    const charged = eventsOfType(events, 'usage.charged').map(
      (event): CallFacts => ({
        inputTokens: event.inputTokens,
        cachedInputTokens: event.cachedInputTokens,
        cacheWriteInputTokens: event.cacheWriteInputTokens ?? 0,
        cost: event.cost?.amount,
        durationMs: event.timing?.durationMs,
      }),
    );
    return [...responded, ...charged];
  });
  const settled = reflectionCallOf(reflection);
  return { calls: settled.call === undefined ? calls : [...calls, settled.call], layers, anatomyTotal, unsettledReflections: settled.unsettled ? 1 : 0 };
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

export const caseTotalsOf = (facts: readonly TokenFacts[]): CaseTokenTotals => {
  const calls = facts.flatMap((entry) => entry.calls);
  const unsettledReflections = facts.reduce((sum, entry) => sum + entry.unsettledReflections, 0);
  if (unsettledReflections > 0) return { calls: calls.length, unsettledReflections };
  const consistent = (call: CallFacts): boolean => call.cachedInputTokens === undefined || call.cachedInputTokens + call.cacheWriteInputTokens <= call.inputTokens;
  const inputTokens = sumOver(calls, (call) => call.inputTokens);
  const cachedInputTokens = sumOver(calls, (call) => (consistent(call) ? call.cachedInputTokens : undefined));
  const uncachedInputTokens = sumOver(calls, (call) => (call.cachedInputTokens === undefined || !consistent(call) ? undefined : call.inputTokens - call.cachedInputTokens - call.cacheWriteInputTokens));
  const cost = sumOver(calls, (call) => call.cost);
  const latencyMs = sumOver(calls, (call) => call.durationMs);
  return {
    calls: calls.length,
    unsettledReflections,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(uncachedInputTokens === undefined ? {} : { uncachedInputTokens }),
    ...(cost === undefined ? {} : { cost }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
  };
};

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
  const clusters: Cluster[] = [];
  for (const entry of cases) {
    if (entry.totals.unsettledReflections > 0) return undefined;
    const numerator = numeratorOf(entry.totals);
    if (numerator === undefined) return undefined;
    clusters.push({ numerator, denominator: entry.passedRuns });
  }
  if (clusters.length === 0 || cases.every((entry) => entry.totals.calls === 0)) return undefined;
  return ratioOf(clusters, seed);
};

const cacheHitRatioOf = (cases: readonly CaseForMetrics[], seed: number): RatioMetric | undefined => {
  const clusters: Cluster[] = [];
  for (const entry of cases) {
    const { inputTokens, cachedInputTokens } = entry.totals;
    if (inputTokens === undefined || cachedInputTokens === undefined) return undefined;
    clusters.push({ numerator: cachedInputTokens, denominator: inputTokens });
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
  uncachedInputPerSuccess: perSuccess(cases, (totals) => totals.uncachedInputTokens, seed),
  callsPerSuccess: perSuccess(cases, (totals) => totals.calls, seed),
  latencyPerSuccess: perSuccess(cases, (totals) => totals.latencyMs, seed),
  cacheHitRatio: cacheHitRatioOf(cases, seed),
  layerShares: layerSharesOf(cases, seed),
});
