import { GENAI_SEMCONV, MOMONGA_ATTRIBUTES, OPERATIONS, UNKNOWN_BILLING } from './semconv.ts';
import { priceCall } from './cost.ts';
import type { CallBilling, PriceTable, PricedCall } from './cost.ts';
import type { SpanRecord, TraceStore } from './trace-store.ts';

const A = GENAI_SEMCONV.attributes;

export type BilledCall = {
  runId: string;
  spanId: string;
  step?: number;
  role?: string;
  responseId?: string;
  provider: string;
  model: string;
  billing: CallBilling;
  startMs: number;
  usage: { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningTokens: number };
  price: PricedCall;
};

export type BilledCallWire = Omit<BilledCall, 'price' | 'spanId'> & {
  price: { kind: 'priced'; units: string; priceVersion: string } | { kind: 'unpriced'; reason: string };
};

export type BilledCallsCursor = { run: number; after: number };

export type BilledCallsPage = { calls: BilledCallWire[]; next?: BilledCallsCursor };

export const MAX_BILLED_CALLS_PAGE = 500;

export const RUNLESS = '';

export const isBilledChat = (span: SpanRecord): boolean =>
  span.attributes[A.ATTR_GEN_AI_OPERATION_NAME] === OPERATIONS.chat && span.attributes[A.ATTR_GEN_AI_USAGE_INPUT_TOKENS] !== undefined;

const optionalNumber = (span: SpanRecord, key: string): number => {
  const value = span.attributes[key];
  if (value === undefined) return 0;
  if (typeof value !== 'number') throw new TypeError(`chat span ${span.spanId} attribute ${key} must be a number`);
  return value;
};

const optionalString = (span: SpanRecord, key: string): string | undefined => {
  const value = span.attributes[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`chat span ${span.spanId} attribute ${key} must be a string`);
  return value;
};

const billingOf = (span: SpanRecord): CallBilling => {
  const value = span.attributes[MOMONGA_ATTRIBUTES.billing];
  return value === 'metered' || value === 'local' ? value : UNKNOWN_BILLING;
};

export const billedCallOf = (runId: string, span: SpanRecord, table: PriceTable): BilledCall => {
  const provider = optionalString(span, A.ATTR_GEN_AI_PROVIDER_NAME) ?? '';
  const model = optionalString(span, A.ATTR_GEN_AI_REQUEST_MODEL) ?? '';
  const billing = billingOf(span);
  const usage = {
    inputTokens: optionalNumber(span, A.ATTR_GEN_AI_USAGE_INPUT_TOKENS),
    cachedInputTokens: optionalNumber(span, A.ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS),
    cacheWriteInputTokens: optionalNumber(span, MOMONGA_ATTRIBUTES.cacheWriteInputTokens),
    outputTokens: optionalNumber(span, A.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS),
    reasoningTokens: optionalNumber(span, A.ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS),
  };
  const step = span.attributes[MOMONGA_ATTRIBUTES.step];
  const role = optionalString(span, MOMONGA_ATTRIBUTES.role);
  const responseId = optionalString(span, A.ATTR_GEN_AI_RESPONSE_ID);
  return {
    runId,
    spanId: span.spanId,
    ...(typeof step === 'number' ? { step } : {}),
    ...(role === undefined ? {} : { role }),
    ...(responseId === undefined ? {} : { responseId }),
    provider,
    model,
    billing,
    startMs: span.startMs,
    usage,
    price: priceCall({
      provider,
      model,
      billing,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens, cacheWriteInputTokens: usage.cacheWriteInputTokens },
      at: new Date(span.startMs),
      table,
    }),
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
