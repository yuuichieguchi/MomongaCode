import { amountOfUnits, computeCostUnits, findPriceEntry } from './cost.ts';
import type { PriceTable } from './cost.ts';
import { GENAI_SEMCONV, MOMONGA_ATTRIBUTES, OPERATIONS, UNKNOWN_BILLING } from './semconv.ts';
import type { ChatBilling } from './spans.ts';
import type { SpanRecord, TraceStore } from './trace-store.ts';

export type BreakdownAnatomy = {
  layers: Readonly<Record<string, number | Readonly<Record<string, number>> | undefined>>;
};

export type BreakdownCall = {
  runId: string;
  step?: number;
  provider: string;
  model: string;
  billing: ChatBilling | typeof UNKNOWN_BILLING;
  at: Date;
  anatomy?: BreakdownAnatomy;
  usage: { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningTokens: number };
  timing?: { firstEventMs?: number; durationMs: number };
};

export type TimingSummary = { median: number; p95: number; n: number };

export type UnpricedCall = { runId: string; provider: string; model: string; step?: number; reason: string };

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
  timeToFirstToken: TimingSummary | null;
  duration: TimingSummary | null;
  cost: { amount: number | null; currency: 'USD'; unpricedCalls: number };
  unpriced: UnpricedCall[];
};

export type CostBreakdownOptions = { table: PriceTable };

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

const unpricedReasonOf = (call: BreakdownCall, table: PriceTable): string | undefined => {
  if (call.billing === UNKNOWN_BILLING) return 'the billing of the target is unknown';
  const entry = findPriceEntry(table, call.provider, call.model, call.at.getTime());
  if (entry === undefined) return 'no price entry';
  if (call.usage.cacheWriteInputTokens > 0 && entry.cacheWritePerMTok === undefined) {
    return `${call.usage.cacheWriteInputTokens} cache write token(s) and the price entry has no cacheWritePerMTok`;
  }
  return undefined;
};

export const buildCostBreakdown = (calls: readonly BreakdownCall[], options: CostBreakdownOptions): CostBreakdown => {
  const { table } = options;
  const layerTokens = new Map<string, number>();
  let callsWithoutAnatomy = 0;
  const billed = { inputTokens: 0, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const firstEvents: number[] = [];
  const durations: number[] = [];
  const unpriced: UnpricedCall[] = [];
  let units = 0n;
  for (const call of calls) {
    if (call.anatomy === undefined) {
      callsWithoutAnatomy += 1;
    } else {
      for (const [name, tokens] of layerEntriesOf(call.anatomy)) layerTokens.set(name, (layerTokens.get(name) ?? 0) + tokens);
    }
    const { usage } = call;
    billed.inputTokens += usage.inputTokens;
    billed.cacheReadTokens += usage.cachedInputTokens;
    billed.cacheWriteTokens += usage.cacheWriteInputTokens;
    billed.uncachedInputTokens += usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens;
    billed.outputTokens += usage.outputTokens;
    billed.reasoningTokens += usage.reasoningTokens;
    if (call.timing !== undefined) {
      if (call.timing.firstEventMs !== undefined) firstEvents.push(call.timing.firstEventMs);
      durations.push(call.timing.durationMs);
    }
    const reason = unpricedReasonOf(call, table);
    if (reason !== undefined) {
      unpriced.push({ runId: call.runId, provider: call.provider, model: call.model, ...(call.step === undefined ? {} : { step: call.step }), reason });
      continue;
    }
    const priced = computeCostUnits({
      provider: call.provider,
      model: call.model,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens },
      at: call.at,
      table,
    });
    if (priced === null) throw new Error(`call of run ${call.runId} on ${call.provider}/${call.model} was judged priced but computeCostUnits found no price`);
    units += priced.units;
  }
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
    cacheHitRatio: billed.inputTokens === 0 ? null : billed.cacheReadTokens / billed.inputTokens,
    timeToFirstToken: summarize(firstEvents),
    duration: summarize(durations),
    cost: { amount: unpriced.length === 0 ? amountOfUnits(units) : null, currency: 'USD', unpricedCalls: unpriced.length },
    unpriced,
  };
};

export type RecordedCall = Pick<BreakdownCall, 'runId' | 'anatomy' | 'timing'> & { step: number };

const A = GENAI_SEMCONV.attributes;

const spanTokens = (span: SpanRecord, key: string, required: boolean): number => {
  const value = span.attributes[key];
  if (value === undefined && !required) return 0;
  if (typeof value !== 'number') throw new TypeError(`chat span ${span.spanId} attribute ${key} must be a number`);
  return value;
};

const spanString = (span: SpanRecord, key: string): string => {
  const value = span.attributes[key];
  if (typeof value !== 'string') throw new TypeError(`chat span ${span.spanId} attribute ${key} must be a string`);
  return value;
};

const spanBilling = (span: SpanRecord): BreakdownCall['billing'] => {
  const value = spanString(span, MOMONGA_ATTRIBUTES.billing);
  if (value === 'metered' || value === 'local' || value === UNKNOWN_BILLING) return value;
  throw new TypeError(`chat span ${span.spanId} attribute ${MOMONGA_ATTRIBUTES.billing} must be metered, local or ${UNKNOWN_BILLING}`);
};

const callOfSpan = (runId: string, span: SpanRecord, recorded: Partial<RecordedCall>): BreakdownCall => ({
  runId,
  provider: spanString(span, A.ATTR_GEN_AI_PROVIDER_NAME),
  model: spanString(span, A.ATTR_GEN_AI_REQUEST_MODEL),
  billing: spanBilling(span),
  at: new Date(span.startMs),
  usage: {
    inputTokens: spanTokens(span, A.ATTR_GEN_AI_USAGE_INPUT_TOKENS, true),
    cachedInputTokens: spanTokens(span, A.ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, false),
    cacheWriteInputTokens: spanTokens(span, MOMONGA_ATTRIBUTES.cacheWriteInputTokens, false),
    outputTokens: spanTokens(span, A.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, true),
    reasoningTokens: spanTokens(span, A.ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS, false),
  },
  ...(recorded.step === undefined ? {} : { step: recorded.step }),
  ...(recorded.anatomy === undefined ? {} : { anatomy: recorded.anatomy }),
  ...(recorded.timing === undefined ? {} : { timing: recorded.timing }),
});

const isBilledChat = (span: SpanRecord): boolean =>
  span.attributes[A.ATTR_GEN_AI_OPERATION_NAME] === OPERATIONS.chat && span.attributes[A.ATTR_GEN_AI_USAGE_INPUT_TOKENS] !== undefined;

export const joinBreakdownCalls = (store: TraceStore, runIds: readonly string[], recorded: readonly RecordedCall[]): BreakdownCall[] =>
  runIds.flatMap((runId) => {
    const billed = store
      .spansForRun(runId)
      .filter(isBilledChat)
      .toSorted((left, right) => left.startMs - right.startMs);
    const aside = billed.filter((span) => span.attributes[MOMONGA_ATTRIBUTES.purpose] !== undefined);
    const modelSpans = billed.filter((span) => span.attributes[MOMONGA_ATTRIBUTES.purpose] === undefined);
    const responses = recorded.filter((call) => call.runId === runId);
    const stepOf = (span: SpanRecord): number | undefined => {
      const step = span.attributes[MOMONGA_ATTRIBUTES.step];
      return typeof step === 'number' ? step : undefined;
    };
    const steps = [...new Set([...modelSpans.map(stepOf), ...responses.map((call) => call.step)])];
    const joined = steps.flatMap((step) => {
      const spans = modelSpans.filter((span) => stepOf(span) === step);
      const calls = responses.filter((call) => call.step === step);
      if (spans.length !== calls.length) {
        throw new Error(`run ${runId} step ${step} recorded ${calls.length} model response(s) but the trace holds ${spans.length} billed chat span(s) for it`);
      }
      return spans.map((span, index) => callOfSpan(runId, span, calls[index] as RecordedCall));
    });
    const asideStep = (span: SpanRecord): Partial<RecordedCall> => {
      const step = stepOf(span);
      return step === undefined ? {} : { step };
    };
    return [...joined, ...aside.map((span) => callOfSpan(runId, span, asideStep(span)))];
  });

const percent = (share: number): string => `${(share * 100).toFixed(1)}%`;

const timingLine = (label: string, summary: TimingSummary | null): string =>
  summary === null ? `${label}: not recorded` : `${label}: median ${summary.median} ms, p95 ${summary.p95} ms (n=${summary.n})`;

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
    `billed tokens: input ${billed.inputTokens} = uncached ${billed.uncachedInputTokens} + cache read ${billed.cacheReadTokens} + cache write ${billed.cacheWriteTokens}; output ${billed.outputTokens} (reasoning ${billed.reasoningTokens})`,
    breakdown.cacheHitRatio === null ? 'cache hit ratio: none (no input)' : `cache hit ratio: ${percent(breakdown.cacheHitRatio)}`,
    timingLine('time to first token', breakdown.timeToFirstToken),
    timingLine('duration', breakdown.duration),
    cost,
    ...breakdown.unpriced.map(
      (entry) => `unpriced: ${entry.provider}/${entry.model} (run ${entry.runId}${entry.step === undefined ? '' : `, step ${entry.step}`}): ${entry.reason}`,
    ),
  ].join('\n');
};
