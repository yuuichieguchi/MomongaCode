import { describeFallbackCause } from '@momonga/foundation';
import type { FallbackCause } from '@momonga/foundation';
import { GENAI_SEMCONV, MOMONGA_ATTRIBUTES, OPERATIONS, UNKNOWN_BILLING } from './semconv.ts';
import { amountOfUnits, computeCostUnits } from './cost.ts';
import type { PriceTable } from './cost.ts';
import type { SpanRecord, TraceStore } from './trace-store.ts';

const A = GENAI_SEMCONV.attributes;

export type CostedRun = { runId: string; sessionId: string };

export type CostFallback = { answeredBy: string; calls: number; failed: FallbackCause[] };

export const RUN_ROLE = 'run';

export type RoleCost = {
  fallbackCalls?: number;
  fallbacks?: CostFallback[];
  calls: number;
  localCalls: number;
  unpricedCalls: number;
  unknownBillingCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  amount: number;
  currency: 'USD';
  priceVersions: string[];
};

export type CostTotals = RoleCost & { roles: Record<string, RoleCost> };

export type RunCost = CostTotals & { runId: string; sessionId: string };
export type SessionCost = CostTotals & { sessionId: string; runIds: string[] };
export type CostReport = { runs: RunCost[]; sessions: SessionCost[]; total: CostTotals };

export type CostReportOptions = { table: PriceTable; includeRunless?: boolean };

type Accumulator = {
  calls: number;
  localCalls: number;
  unpricedCalls: number;
  unknownBillingCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  units: bigint;
  priceVersions: Set<string>;
  fallbacks: Map<string, CostFallback>;
  roles: Map<string, Accumulator>;
};

const emptyAccumulator = (): Accumulator => ({
  fallbacks: new Map(),
  roles: new Map(),
  calls: 0,
  localCalls: 0,
  unpricedCalls: 0,
  unknownBillingCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  units: 0n,
  priceVersions: new Set(),
});

const merge = (target: Accumulator, source: Accumulator): void => {
  target.calls += source.calls;
  target.localCalls += source.localCalls;
  target.unpricedCalls += source.unpricedCalls;
  target.unknownBillingCalls += source.unknownBillingCalls;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.units += source.units;
  for (const version of source.priceVersions) target.priceVersions.add(version);
  for (const fallback of source.fallbacks.values()) addFallback(target, fallback.answeredBy, fallback.failed, fallback.calls);
  for (const [role, sourceRole] of source.roles) {
    const targetRole = target.roles.get(role) ?? emptyAccumulator();
    merge(targetRole, sourceRole);
    target.roles.set(role, targetRole);
  }
};

const addFallback = (accumulator: Accumulator, answeredBy: string, failed: FallbackCause[], calls: number): void => {
  const key = `${answeredBy}\n${JSON.stringify(failed)}`;
  const known = accumulator.fallbacks.get(key);
  if (known === undefined) accumulator.fallbacks.set(key, { answeredBy, calls, failed });
  else known.calls += calls;
};

const fallbackCausesOf = (span: SpanRecord): FallbackCause[] | undefined => {
  const value = span.attributes[MOMONGA_ATTRIBUTES.fallbackCauses];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`chat span ${span.spanId} attribute ${MOMONGA_ATTRIBUTES.fallbackCauses} must be a string`);
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new TypeError(`chat span ${span.spanId} attribute ${MOMONGA_ATTRIBUTES.fallbackCauses} must hold a list`);
  return parsed as FallbackCause[];
};

const fallbackTotalsOf = (accumulator: Accumulator): Pick<CostTotals, 'fallbackCalls' | 'fallbacks'> => {
  const fallbacks = [...accumulator.fallbacks.values()];
  if (fallbacks.length === 0) return {};
  return { fallbackCalls: fallbacks.reduce((total, fallback) => total + fallback.calls, 0), fallbacks };
};

const roleTotalsOf = (accumulator: Accumulator): RoleCost => ({
  ...fallbackTotalsOf(accumulator),
  calls: accumulator.calls,
  localCalls: accumulator.localCalls,
  unpricedCalls: accumulator.unpricedCalls,
  unknownBillingCalls: accumulator.unknownBillingCalls,
  inputTokens: accumulator.inputTokens,
  outputTokens: accumulator.outputTokens,
  cachedInputTokens: accumulator.cachedInputTokens,
  amount: amountOfUnits(accumulator.units),
  currency: 'USD',
  priceVersions: [...accumulator.priceVersions].sort(),
});

const totalsOf = (accumulator: Accumulator): CostTotals => ({
  ...roleTotalsOf(accumulator),
  roles: Object.fromEntries([...accumulator.roles].map(([role, forRole]) => [role, roleTotalsOf(forRole)])),
});

const stringAttribute = (span: SpanRecord, key: string): string => {
  const value = span.attributes[key];
  if (typeof value !== 'string') throw new TypeError(`chat span ${span.spanId} attribute ${key} must be a string`);
  return value;
};

const tokenAttribute = (span: SpanRecord, key: string, required: boolean): number => {
  const value = span.attributes[key];
  if (value === undefined && !required) return 0;
  if (typeof value !== 'number') throw new TypeError(`chat span ${span.spanId} attribute ${key} must be a number`);
  return value;
};

const isBilledChat = (span: SpanRecord): boolean =>
  span.attributes[A.ATTR_GEN_AI_OPERATION_NAME] === OPERATIONS.chat && span.attributes[A.ATTR_GEN_AI_USAGE_INPUT_TOKENS] !== undefined;

const roleOf = (span: SpanRecord): string => {
  const value = span.attributes[MOMONGA_ATTRIBUTES.role];
  if (value === undefined) return RUN_ROLE;
  if (typeof value !== 'string') throw new TypeError(`chat span ${span.spanId} attribute ${MOMONGA_ATTRIBUTES.role} must be a string`);
  return value;
};

const addSpan = (accumulator: Accumulator, span: SpanRecord, table: PriceTable): void => {
  const usage = {
    inputTokens: tokenAttribute(span, A.ATTR_GEN_AI_USAGE_INPUT_TOKENS, true),
    outputTokens: tokenAttribute(span, A.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, true),
    cachedInputTokens: tokenAttribute(span, A.ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, false),
  };
  accumulator.calls += 1;
  const causes = fallbackCausesOf(span);
  if (causes !== undefined) addFallback(accumulator, stringAttribute(span, MOMONGA_ATTRIBUTES.target), causes, 1);
  accumulator.inputTokens += usage.inputTokens;
  accumulator.outputTokens += usage.outputTokens;
  accumulator.cachedInputTokens += usage.cachedInputTokens;
  const billing = stringAttribute(span, MOMONGA_ATTRIBUTES.billing);
  if (billing === 'local') {
    accumulator.localCalls += 1;
    return;
  }
  if (billing === UNKNOWN_BILLING) {
    accumulator.unknownBillingCalls += 1;
    return;
  }
  const priced = computeCostUnits({
    provider: stringAttribute(span, A.ATTR_GEN_AI_PROVIDER_NAME),
    model: stringAttribute(span, A.ATTR_GEN_AI_REQUEST_MODEL),
    usage,
    at: new Date(span.startMs),
    table,
  });
  if (priced === null) {
    accumulator.unpricedCalls += 1;
  } else {
    accumulator.units += priced.units;
    accumulator.priceVersions.add(priced.priceVersion);
  }
};

const accumulateSpans = (spans: readonly SpanRecord[], table: PriceTable): Accumulator => {
  const accumulator = emptyAccumulator();
  for (const span of spans.filter(isBilledChat)) {
    addSpan(accumulator, span, table);
    const role = roleOf(span);
    const forRole = accumulator.roles.get(role) ?? emptyAccumulator();
    addSpan(forRole, span, table);
    accumulator.roles.set(role, forRole);
  }
  return accumulator;
};

export const buildCostReport = (store: TraceStore, runs: readonly CostedRun[], options: CostReportOptions): CostReport => {
  const { table } = options;
  const seenRuns = new Set<string>();
  const perRun: { run: CostedRun; accumulator: Accumulator }[] = runs.map((run) => {
    if (seenRuns.has(run.runId)) throw new Error(`buildCostReport: run ${run.runId} is listed twice`);
    seenRuns.add(run.runId);
    return { run, accumulator: accumulateSpans(store.spansForRun(run.runId), table) };
  });
  const sessions = new Map<string, { runIds: string[]; accumulator: Accumulator }>();
  const total = emptyAccumulator();
  if (options.includeRunless === true) merge(total, accumulateSpans(store.spansWithoutRun(), table));
  for (const { run, accumulator } of perRun) {
    const session = sessions.get(run.sessionId) ?? { runIds: [], accumulator: emptyAccumulator() };
    session.runIds.push(run.runId);
    merge(session.accumulator, accumulator);
    sessions.set(run.sessionId, session);
    merge(total, accumulator);
  }
  return {
    runs: perRun.map(({ run, accumulator }) => ({ runId: run.runId, sessionId: run.sessionId, ...totalsOf(accumulator) })),
    sessions: [...sessions].map(([sessionId, session]) => ({ sessionId, runIds: session.runIds, ...totalsOf(session.accumulator) })),
    total: totalsOf(total),
  };
};

const describeTotals = (totals: RoleCost): string => {
  const versions = totals.priceVersions.length === 0 ? 'none' : totals.priceVersions.join(',');
  const local = totals.localCalls === 0 ? '' : `, ${totals.localCalls} of ${totals.calls} call(s) ran locally and cost nothing`;
  const unpriced = totals.unpricedCalls === 0 ? '' : `, ${totals.unpricedCalls} of ${totals.calls} call(s) have no price entry and are not counted`;
  const unknown = totals.unknownBillingCalls === 0 ? '' : `, ${totals.unknownBillingCalls} of ${totals.calls} call(s) have unknown billing and are not counted`;
  const fallback = (totals.fallbacks ?? []).map(
    (entry) =>
      `, ${entry.calls} of ${totals.calls} call(s) were answered by fallback target ${entry.answeredBy} after ${entry.failed.map(describeFallbackCause).join('; ')}`,
  );
  return `${totals.calls} call(s), ${totals.inputTokens} input (${totals.cachedInputTokens} cached) + ${totals.outputTokens} output tokens, ${totals.amount} ${totals.currency} at price version ${versions}${local}${unpriced}${unknown}${fallback.join('')}`;
};

export const formatCostReport = (report: CostReport): string => {
  const lines = ['cost report'];
  const roleLines = (totals: CostTotals, indent: string): string[] =>
    Object.entries(totals.roles)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([role, forRole]) => `${indent}role ${role}: ${describeTotals(forRole)}`);
  for (const session of report.sessions) {
    lines.push(`  session ${session.sessionId}: ${describeTotals(session)}`, ...roleLines(session, '    '));
    for (const run of report.runs.filter((entry) => entry.sessionId === session.sessionId)) {
      lines.push(`    run ${run.runId}: ${describeTotals(run)}`, ...roleLines(run, '      '));
    }
  }
  lines.push(`  total: ${describeTotals(report.total)}`, ...roleLines(report.total, '    '));
  return lines.join('\n');
};
