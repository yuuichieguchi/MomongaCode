import { GENAI_SEMCONV, MOMONGA_ATTRIBUTES, OPERATIONS, UNKNOWN_BILLING } from './semconv.ts';
import type { CallBilling } from './cost.ts';
import type { CallPrice } from './money-line.ts';
import type { SpanRecord, TraceStore } from './trace-store.ts';
import { SPAN_ATTRIBUTE_RENAMES, isFallbackCauseList, unitsOfCost, withCurrentNames } from '@momonga/protocol';
import type { FallbackCause, RecordedPrice } from '@momonga/protocol';

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
  fallbackCauses?: FallbackCause[];
};

export type BilledCallWire = Omit<BilledCall, 'spanId'>;

export type PricedBilledCall = BilledCallWire & { price: CallPrice };

export const callPriceOf = (recorded: RecordedPrice): CallPrice =>
  recorded.kind === 'priced' ? { kind: 'priced', units: unitsOfCost(recorded.cost), currency: recorded.cost.currency, priceVersion: recorded.cost.priceVersion } : recorded;

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

const fallbackCausesOf = (span: SpanRecord): FallbackCause[] | undefined => {
  const value = optionalString(span, MOMONGA_ATTRIBUTES.fallbackCauses);
  if (value === undefined) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!isFallbackCauseList(parsed)) throw new TypeError(`chat span ${span.spanId} attribute ${MOMONGA_ATTRIBUTES.fallbackCauses} must hold a list of fallback causes`);
  return parsed;
};

export const billedUsageOf = (stored: SpanRecord): BilledCall['usage'] => {
  const span: SpanRecord = { ...stored, attributes: withCurrentNames(stored.attributes, SPAN_ATTRIBUTE_RENAMES) };
  const cachedInputTokens = reportedNumber(span, A.ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS);
  return {
    inputTokens: reportedNumber(span, A.ATTR_GEN_AI_USAGE_INPUT_TOKENS) ?? 0,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    cacheWriteInputTokens: reportedNumber(span, A.ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS) ?? 0,
    outputTokens: reportedNumber(span, A.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS) ?? 0,
    reasoningTokens: reportedNumber(span, A.ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS) ?? 0,
  };
};

export const billedCallOf = (runId: string, span: SpanRecord): BilledCall => {
  const provider = optionalString(span, A.ATTR_GEN_AI_PROVIDER_NAME) ?? '';
  const model = optionalString(span, A.ATTR_GEN_AI_REQUEST_MODEL) ?? '';
  const billing = billingOf(span);
  const usage = billedUsageOf(span);
  const step = span.attributes[MOMONGA_ATTRIBUTES.step];
  const role = optionalString(span, MOMONGA_ATTRIBUTES.role);
  const responseId = optionalString(span, A.ATTR_GEN_AI_RESPONSE_ID);
  const target = optionalString(span, MOMONGA_ATTRIBUTES.target);
  const fallbackCauses = fallbackCausesOf(span);
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
    ...(fallbackCauses === undefined ? {} : { fallbackCauses }),
  };
};

const wireOf = (call: BilledCall): BilledCallWire => {
  const { spanId: _spanId, ...rest } = call;
  return rest;
};

export const pageBilledCalls = (
  store: TraceStore,
  runIds: readonly string[],
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
    calls.push(...taken.map(({ span }) => wireOf(billedCallOf(runId ?? RUNLESS, span))));
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
