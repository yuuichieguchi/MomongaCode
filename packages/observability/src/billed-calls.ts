import { GENAI_SEMCONV, MOMONGA_ATTRIBUTES, OPERATIONS, UNKNOWN_BILLING } from './semconv.ts';
import { priceCall } from './cost.ts';
import type { CallBilling, PriceTable, PricedCall } from './cost.ts';
import type { SpanRecord, TraceStore } from './trace-store.ts';
import type { PriceNotRecorded, UnpricedCode, UsageSource } from '@momonga/protocol';

const A = GENAI_SEMCONV.attributes;

export type BilledCall = {
  runId: string;
  spanId: string;
  step?: number;
  role?: string;
  responseId?: string;
  target?: string;
  provider: string;
  model: string;
  billing: CallBilling;
  startMs: number;
  usage: { inputTokens: number; cachedInputTokens?: number; cacheWriteInputTokens: number; outputTokens: number; reasoningTokens: number };
  price: PricedCall | PriceNotRecorded;
};

export type BilledCallWire = Omit<BilledCall, 'price' | 'spanId'> & {
  price: { kind: 'priced'; units: string; priceVersion: string } | { kind: 'unpriced'; code: UnpricedCode; reason: string } | PriceNotRecorded;
};

export type BilledCallsCursor = { run: number; after: number };

export type BilledCallsPage = { calls: BilledCallWire[]; next?: BilledCallsCursor };

export const MAX_BILLED_CALLS_PAGE = 500;

export const RUNLESS = '';

export const isBilledChat = (span: SpanRecord): boolean =>
  span.attributes[A.ATTR_GEN_AI_OPERATION_NAME] === OPERATIONS.chat && span.attributes[A.ATTR_GEN_AI_USAGE_INPUT_TOKENS] !== undefined;

const reportedNumber = (span: SpanRecord, key: string): number | undefined => {
  const value = span.attributes[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') throw new TypeError(`chat span ${span.spanId} attribute ${key} must be a number`);
  return value;
};

const usageSourceOf = (span: SpanRecord): UsageSource | undefined => {
  const value = optionalString(span, MOMONGA_ATTRIBUTES.usageSource);
  if (value === undefined || value === 'reported' || value === 'estimated') return value;
  throw new TypeError(`chat span ${span.spanId} attribute ${MOMONGA_ATTRIBUTES.usageSource} must be reported or estimated, got ${value}`);
};

const optionalString = (span: SpanRecord, key: string): string | undefined => {
  const value = span.attributes[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`chat span ${span.spanId} attribute ${key} must be a string`);
  return value;
};

const billingOf = (span: SpanRecord): CallBilling => {
  const value = span.attributes[MOMONGA_ATTRIBUTES.billing];
  return value === 'metered' || value === 'local' || value === 'plan' ? value : UNKNOWN_BILLING;
};

export const billedUsageOf = (span: SpanRecord): BilledCall['usage'] => {
  const cachedInputTokens = reportedNumber(span, A.ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS);
  return {
    inputTokens: reportedNumber(span, A.ATTR_GEN_AI_USAGE_INPUT_TOKENS) ?? 0,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    cacheWriteInputTokens: reportedNumber(span, MOMONGA_ATTRIBUTES.cacheWriteInputTokens) ?? 0,
    outputTokens: reportedNumber(span, A.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS) ?? 0,
    reasoningTokens: reportedNumber(span, A.ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS) ?? 0,
  };
};

export const billedCallOf = (runId: string, span: SpanRecord, table: PriceTable): BilledCall => {
  const provider = optionalString(span, A.ATTR_GEN_AI_PROVIDER_NAME) ?? '';
  const model = optionalString(span, A.ATTR_GEN_AI_REQUEST_MODEL) ?? '';
  const billing = billingOf(span);
  const usage = billedUsageOf(span);
  const usageSource = usageSourceOf(span);
  const step = span.attributes[MOMONGA_ATTRIBUTES.step];
  const role = optionalString(span, MOMONGA_ATTRIBUTES.role);
  const responseId = optionalString(span, A.ATTR_GEN_AI_RESPONSE_ID);
  const target = optionalString(span, MOMONGA_ATTRIBUTES.target);
  return {
    runId,
    spanId: span.spanId,
    ...(typeof step === 'number' ? { step } : {}),
    ...(role === undefined ? {} : { role }),
    ...(responseId === undefined ? {} : { responseId }),
    ...(target === undefined ? {} : { target }),
    provider,
    model,
    billing,
    startMs: span.startMs,
    usage,
    price: usageSource === undefined ? { kind: 'not_recorded' } : priceCall({ provider, model, billing, usageSource, usage, at: new Date(span.startMs), table }),
  };
};

export const billedCallsOfRun = (store: TraceStore, runId: string, table: PriceTable): BilledCall[] =>
  store
    .spansForRun(runId)
    .filter(isBilledChat)
    .toSorted((left, right) => left.startMs - right.startMs || (left.spanId < right.spanId ? -1 : 1))
    .map((span) => billedCallOf(runId, span, table));

const wireOf = (call: BilledCall): BilledCallWire => {
  const { price, spanId: _spanId, ...rest } = call;
  return { ...rest, price: price.kind === 'priced' ? { kind: 'priced', units: price.units.toString(), priceVersion: price.priceVersion } : price };
};

export const pageBilledCalls = (
  store: TraceStore,
  runIds: readonly string[],
  table: PriceTable,
  cursor: BilledCallsCursor,
  limit: number,
  includeRunless: boolean,
): BilledCallsPage => {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BILLED_CALLS_PAGE) {
    throw new RangeError(`a page holds 1 to ${MAX_BILLED_CALLS_PAGE} calls, received ${limit}`);
  }
  const calls: BilledCallWire[] = [];
  let run = cursor.run;
  let after = cursor.after;
  const slots = runIds.length + (includeRunless ? 1 : 0);
  while (run < slots && calls.length < limit) {
    const runId = runIds[run];
    const want = limit - calls.length;
    const found = store.billedChatSpansAfter(runId ?? null, after, want + 1);
    const taken = found.slice(0, want);
    calls.push(...taken.map(({ span }) => wireOf(billedCallOf(runId ?? RUNLESS, span, table))));
    const last = taken.at(-1);
    if (found.length > want && last !== undefined) {
      after = last.seq;
    } else {
      run += 1;
      after = 0;
    }
  }
  return run < slots ? { calls, next: { run, after } } : { calls };
};
