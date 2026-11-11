import { RUN_ROLE, UNPRICED_CODE_TEXT, describeFallbackCause, escapeTerminalLine } from '@momonga/protocol';
import type { FallbackCause, UnpricedCode } from '@momonga/protocol';
import { RUNLESS } from './billed-calls.ts';
import type { PricedBilledCall } from './billed-calls.ts';
import { CACHE_READ_TEXT, isCacheReadReported, noCallReported } from './cache-reads.ts';
import { LOCAL_PRICE_VERSION, amountOfUnits } from './cost.ts';
import { describeMoney, moneyAmountOf, unpricedCallsOf } from './money-line.ts';
import type { MoneyTally } from './money-line.ts';

export type CostedRun = { runId: string; sessionId: string };

export type CostFallback = { answeredBy: string; calls: number; failed: FallbackCause[] };

export type RoleCost = {
  fallbackCalls?: number;
  fallbacks?: CostFallback[];
  calls: number;
  localCalls: number;
  unpricedCalls: number;
  unknownBillingCalls: number;
  cacheReadNotReportedCalls: number;
  cacheReadUnpricedCalls: number;
  planCalls: number;
  planInputTokens: number;
  planOutputTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
  amount: number | null;
  currency: 'USD';
  priceVersions: string[];
  unpriced: Partial<Record<UnpricedCode, number>>;
  priceNotRecordedCalls: number;
  legacyPrecisionCalls: number;
};

export type CostTotals = RoleCost & { roles: Record<string, RoleCost> };

export type RunCost = CostTotals & { runId: string; sessionId: string };
export type SessionCost = CostTotals & { sessionId: string; runIds: string[] };
export type CostReport = { runs: RunCost[]; sessions: SessionCost[]; total: CostTotals };

export type CostReportOptions = { includeRunless?: boolean };

type Accumulator = {
  calls: number;
  localCalls: number;
  unpriced: Partial<Record<UnpricedCode, number>>;
  priceNotRecordedCalls: number;
  legacyPrecisionCalls: number;
  cacheReadNotReportedCalls: number;
  planInputTokens: number;
  planOutputTokens: number;
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
  unpriced: {},
  priceNotRecordedCalls: 0,
  legacyPrecisionCalls: 0,
  cacheReadNotReportedCalls: 0,
  planInputTokens: 0,
  planOutputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  units: 0n,
  priceVersions: new Set(),
});

const addUnpriced = (accumulator: Accumulator, code: UnpricedCode, count: number): void => {
  accumulator.unpriced[code] = (accumulator.unpriced[code] ?? 0) + count;
};

const countOf = (accumulator: Accumulator, code: UnpricedCode): number => accumulator.unpriced[code] ?? 0;

const merge = (target: Accumulator, source: Accumulator): void => {
  target.calls += source.calls;
  target.localCalls += source.localCalls;
  for (const [code, count] of Object.entries(source.unpriced) as [UnpricedCode, number][]) addUnpriced(target, code, count);
  target.priceNotRecordedCalls += source.priceNotRecordedCalls;
  target.legacyPrecisionCalls += source.legacyPrecisionCalls;
  target.cacheReadNotReportedCalls += source.cacheReadNotReportedCalls;
  target.planInputTokens += source.planInputTokens;
  target.planOutputTokens += source.planOutputTokens;
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

const fallbackTotalsOf = (accumulator: Accumulator): Pick<CostTotals, 'fallbackCalls' | 'fallbacks'> => {
  const fallbacks = [...accumulator.fallbacks.values()];
  if (fallbacks.length === 0) return {};
  return { fallbackCalls: fallbacks.reduce((total, fallback) => total + fallback.calls, 0), fallbacks };
};

const moneyTallyOfAccumulator = (accumulator: Accumulator): MoneyTally => ({
  calls: accumulator.calls,
  unpriced: accumulator.unpriced,
  priceNotRecorded: accumulator.priceNotRecordedCalls,
  amount: amountOfUnits(accumulator.units),
  meteredPriceVersions: [...accumulator.priceVersions].sort(),
  legacyPrecisionCalls: accumulator.legacyPrecisionCalls,
});

const roleTotalsOf = (accumulator: Accumulator): RoleCost => ({
  ...fallbackTotalsOf(accumulator),
  calls: accumulator.calls,
  localCalls: accumulator.localCalls,
  unpricedCalls: unpricedCallsOf(accumulator.unpriced),
  unknownBillingCalls: countOf(accumulator, 'unknown_billing'),
  cacheReadNotReportedCalls: accumulator.cacheReadNotReportedCalls,
  cacheReadUnpricedCalls: countOf(accumulator, 'cache_read_not_reported'),
  planCalls: countOf(accumulator, 'plan'),
  planInputTokens: accumulator.planInputTokens,
  planOutputTokens: accumulator.planOutputTokens,
  inputTokens: accumulator.inputTokens,
  outputTokens: accumulator.outputTokens,
  cachedInputTokens: noCallReported({ calls: accumulator.calls, notReported: accumulator.cacheReadNotReportedCalls }) ? null : accumulator.cachedInputTokens,
  amount: moneyAmountOf(moneyTallyOfAccumulator(accumulator)),
  currency: 'USD',
  priceVersions: [...accumulator.priceVersions].sort(),
  unpriced: { ...accumulator.unpriced },
  priceNotRecordedCalls: accumulator.priceNotRecordedCalls,
  legacyPrecisionCalls: accumulator.legacyPrecisionCalls,
});

const totalsOf = (accumulator: Accumulator): CostTotals => ({
  ...roleTotalsOf(accumulator),
  roles: Object.fromEntries([...accumulator.roles].map(([role, forRole]) => [role, roleTotalsOf(forRole)])),
});

const answeringTargetOf = (call: PricedBilledCall): string => {
  if (call.target === undefined) throw new TypeError(`a billed call of run ${call.runId} answered after a fallback and names no answering model`);
  return call.target;
};

const addCall = (accumulator: Accumulator, call: PricedBilledCall): void => {
  accumulator.calls += 1;
  if (call.fallbackCauses !== undefined) addFallback(accumulator, answeringTargetOf(call), call.fallbackCauses, 1);
  accumulator.inputTokens += call.usage.inputTokens;
  accumulator.outputTokens += call.usage.outputTokens;
  if (isCacheReadReported(call.usage)) accumulator.cachedInputTokens += call.usage.cachedInputTokens;
  else accumulator.cacheReadNotReportedCalls += 1;
  if (call.billing === 'local') accumulator.localCalls += 1;
  const { price } = call;
  if (price.kind === 'not_recorded') {
    accumulator.priceNotRecordedCalls += 1;
  } else if (price.kind === 'priced') {
    accumulator.units += price.units;
    if ('legacyPrecision' in price) accumulator.legacyPrecisionCalls += 1;
    if (price.priceVersion !== LOCAL_PRICE_VERSION) accumulator.priceVersions.add(price.priceVersion);
  } else {
    addUnpriced(accumulator, price.code, 1);
    if (price.code === 'plan') {
      accumulator.planInputTokens += call.usage.inputTokens;
      accumulator.planOutputTokens += call.usage.outputTokens;
    }
  }
};

const accumulate = (calls: readonly PricedBilledCall[]): Accumulator => {
  const accumulator = emptyAccumulator();
  for (const call of calls) {
    addCall(accumulator, call);
    const role = call.role ?? RUN_ROLE;
    const forRole = accumulator.roles.get(role) ?? emptyAccumulator();
    addCall(forRole, call);
    accumulator.roles.set(role, forRole);
  }
  return accumulator;
};

export const buildCostReport = (calls: readonly PricedBilledCall[], runs: readonly CostedRun[], options: CostReportOptions = {}): CostReport => {
  const callsOfRun = new Map<string, PricedBilledCall[]>(runs.map((run) => [run.runId, []]));
  if (callsOfRun.size !== runs.length) {
    const twice = runs.find((run, index) => runs.findIndex((other) => other.runId === run.runId) !== index);
    throw new Error(`buildCostReport: run ${twice?.runId} is listed twice`);
  }
  const runless: PricedBilledCall[] = [];
  for (const call of calls) {
    const ofRun = call.runId === RUNLESS ? runless : callsOfRun.get(call.runId);
    if (ofRun === undefined) throw new RangeError(`a billed call belongs to run ${call.runId}, which was not asked for`);
    ofRun.push(call);
  }
  const perRun = runs.map((run) => ({ run, accumulator: accumulate(callsOfRun.get(run.runId) ?? []) }));
  const sessions = new Map<string, { runIds: string[]; accumulator: Accumulator }>();
  const total = emptyAccumulator();
  if (options.includeRunless === true) merge(total, accumulate(runless));
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
  const fallback = (totals.fallbacks ?? []).map(
    (entry) =>
      `, ${entry.calls} of ${totals.calls} call(s) were answered by the fallback model ${entry.answeredBy} after ${entry.failed.map(describeFallbackCause).join('; ')}`,
  );
  const money = describeMoney({ calls: totals.calls, unpriced: totals.unpriced, priceNotRecorded: totals.priceNotRecordedCalls, amount: totals.amount, meteredPriceVersions: totals.priceVersions, legacyPrecisionCalls: totals.legacyPrecisionCalls });
  return `${totals.calls} call(s), ${CACHE_READ_TEXT.inputClause({ calls: totals.calls, notReported: totals.cacheReadNotReportedCalls, inputTokens: totals.inputTokens, cachedInputTokens: totals.cachedInputTokens })} + ${totals.outputTokens} output tokens, ${money}${fallback.join('')}`;
};

const planLines = (totals: RoleCost, indent: string): string[] =>
  totals.planCalls === 0 ? [] : [`${indent}  ${UNPRICED_CODE_TEXT.plan}: ${totals.planCalls} call(s), ${totals.planInputTokens} input + ${totals.planOutputTokens} output tokens`];

export const formatCostReport = (report: CostReport): string => {
  const lines = ['cost report'];
  const roleLines = (totals: CostTotals, indent: string): string[] =>
    Object.entries(totals.roles)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([role, forRole]) => [`${indent}role ${role}: ${describeTotals(forRole)}`, ...planLines(forRole, indent)]);
  for (const session of report.sessions) {
    lines.push(`  session ${session.sessionId}: ${describeTotals(session)}`, ...planLines(session, '  '), ...roleLines(session, '    '));
    for (const run of report.runs.filter((entry) => entry.sessionId === session.sessionId)) {
      lines.push(`    run ${run.runId}: ${describeTotals(run)}`, ...planLines(run, '    '), ...roleLines(run, '      '));
    }
  }
  lines.push(`  total: ${describeTotals(report.total)}`, ...planLines(report.total, '  '), ...roleLines(report.total, '    '));
  return lines.map(escapeTerminalLine).join('\n');
};
