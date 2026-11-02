import { GENAI_SEMCONV, MOMONGA_ATTRIBUTES, OPERATIONS } from './semconv.ts';
import { amountOfUnits, computeCostUnits } from './cost.ts';
import type { PriceTable } from './cost.ts';
import type { SpanRecord, TraceStore } from './trace-store.ts';

const A = GENAI_SEMCONV.attributes;

export type CostedRun = { runId: string; sessionId: string };

export type CostTotals = {
  calls: number;
  localCalls: number;
  unpricedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  amount: number;
  currency: 'USD';
  priceVersions: string[];
};

export type RunCost = CostTotals & { runId: string; sessionId: string };
export type SessionCost = CostTotals & { sessionId: string; runIds: string[] };
export type CostReport = { runs: RunCost[]; sessions: SessionCost[]; total: CostTotals };

export type CostReportOptions = { table: PriceTable };

type Accumulator = {
  calls: number;
  localCalls: number;
  unpricedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  units: bigint;
  priceVersions: Set<string>;
};

const emptyAccumulator = (): Accumulator => ({
  calls: 0,
  localCalls: 0,
  unpricedCalls: 0,
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
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.units += source.units;
  for (const version of source.priceVersions) target.priceVersions.add(version);
};

const totalsOf = (accumulator: Accumulator): CostTotals => ({
  calls: accumulator.calls,
  localCalls: accumulator.localCalls,
  unpricedCalls: accumulator.unpricedCalls,
  inputTokens: accumulator.inputTokens,
  outputTokens: accumulator.outputTokens,
  cachedInputTokens: accumulator.cachedInputTokens,
  amount: amountOfUnits(accumulator.units),
  currency: 'USD',
  priceVersions: [...accumulator.priceVersions].sort(),
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

const accumulateRun = (store: TraceStore, runId: string, table: PriceTable): Accumulator => {
  const accumulator = emptyAccumulator();
  for (const span of store.spansForRun(runId).filter(isBilledChat)) {
    const usage = {
      inputTokens: tokenAttribute(span, A.ATTR_GEN_AI_USAGE_INPUT_TOKENS, true),
      outputTokens: tokenAttribute(span, A.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, true),
      cachedInputTokens: tokenAttribute(span, A.ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, false),
    };
    accumulator.calls += 1;
    accumulator.inputTokens += usage.inputTokens;
    accumulator.outputTokens += usage.outputTokens;
    accumulator.cachedInputTokens += usage.cachedInputTokens;
    if (stringAttribute(span, MOMONGA_ATTRIBUTES.billing) === 'local') {
      accumulator.localCalls += 1;
      continue;
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
  }
  return accumulator;
};

export const buildCostReport = (store: TraceStore, runs: readonly CostedRun[], options: CostReportOptions): CostReport => {
  const { table } = options;
  const seenRuns = new Set<string>();
  const perRun: { run: CostedRun; accumulator: Accumulator }[] = runs.map((run) => {
    if (seenRuns.has(run.runId)) throw new Error(`buildCostReport: run ${run.runId} is listed twice`);
    seenRuns.add(run.runId);
    return { run, accumulator: accumulateRun(store, run.runId, table) };
  });
  const sessions = new Map<string, { runIds: string[]; accumulator: Accumulator }>();
  const total = emptyAccumulator();
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

const describeTotals = (totals: CostTotals): string => {
  const versions = totals.priceVersions.length === 0 ? 'none' : totals.priceVersions.join(',');
  const local = totals.localCalls === 0 ? '' : `, ${totals.localCalls} of ${totals.calls} call(s) ran locally and cost nothing`;
  const unpriced = totals.unpricedCalls === 0 ? '' : `, ${totals.unpricedCalls} of ${totals.calls} call(s) have no price entry and are not counted`;
  return `${totals.calls} call(s), ${totals.inputTokens} input (${totals.cachedInputTokens} cached) + ${totals.outputTokens} output tokens, ${totals.amount} ${totals.currency} at price version ${versions}${local}${unpriced}`;
};

export const formatCostReport = (report: CostReport): string => {
  const lines = ['cost report'];
  for (const session of report.sessions) {
    lines.push(`  session ${session.sessionId}: ${describeTotals(session)}`);
    for (const run of report.runs.filter((entry) => entry.sessionId === session.sessionId)) lines.push(`    run ${run.runId}: ${describeTotals(run)}`);
  }
  lines.push(`  total: ${describeTotals(report.total)}`);
  return lines.join('\n');
};
