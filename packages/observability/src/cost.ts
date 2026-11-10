import type { UnpricedOutcome, UsageSource } from '@momonga/protocol';
import { UNKNOWN_BILLING } from './semconv.ts';

export type PriceEntry = {
  provider: string;
  model: string;
  effectiveFrom: string;
  inputPerMTok: number;
  cachedInputPerMTok?: number;
  cacheWritePerMTok?: number;
  outputPerMTok: number;
  currency: 'USD';
};

export type PriceTable = readonly PriceEntry[];

export type CostUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
};

export type CostInput = {
  provider: string;
  model: string;
  usage: CostUsage;
  at: Date;
  table: PriceTable;
};

const PRICE_SCALE_DIGITS = 9;
const PRICE_SCALE = 10 ** PRICE_SCALE_DIGITS;
const TOKENS_PER_MTOK_DIGITS = 6;
const AMOUNT_DIGITS = PRICE_SCALE_DIGITS + TOKENS_PER_MTOK_DIGITS;
const AMOUNT_DIVISOR = 10n ** BigInt(AMOUNT_DIGITS);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const identify = (entry: PriceEntry): string => `${entry.provider}/${entry.model}@${entry.effectiveFrom}`;

const effectiveFromMs = (entry: PriceEntry): number => Date.parse(`${entry.effectiveFrom}T00:00:00Z`);

const assertPrice = (entry: PriceEntry, field: string, price: number): void => {
  if (!Number.isFinite(price) || price < 0) {
    throw new RangeError(`price entry ${identify(entry)}: ${field} must be a non-negative finite number, got ${price}`);
  }
  if (Math.abs(Math.round(price * PRICE_SCALE) - price * PRICE_SCALE) > 1e-3) {
    throw new RangeError(
      `price entry ${identify(entry)}: ${field} has more than ${PRICE_SCALE_DIGITS} decimal places, got ${price}`,
    );
  }
};

export const definePriceTable = (entries: readonly PriceEntry[]): PriceTable => {
  const seen = new Set<string>();
  for (const entry of entries) {
    const identity = identify(entry);
    const currency: string = entry.currency;
    if (currency !== 'USD') throw new RangeError(`price entry ${identity}: currency must be USD, got ${currency}`);
    if (!DATE_PATTERN.test(entry.effectiveFrom) || Number.isNaN(effectiveFromMs(entry))) {
      throw new RangeError(`price entry ${identity}: effectiveFrom must be a valid YYYY-MM-DD date`);
    }
    if (seen.has(identity)) throw new Error(`duplicate price entry ${identity}`);
    seen.add(identity);
    assertPrice(entry, 'inputPerMTok', entry.inputPerMTok);
    assertPrice(entry, 'outputPerMTok', entry.outputPerMTok);
    if (entry.cachedInputPerMTok !== undefined) assertPrice(entry, 'cachedInputPerMTok', entry.cachedInputPerMTok);
    if (entry.cacheWritePerMTok !== undefined) assertPrice(entry, 'cacheWritePerMTok', entry.cacheWritePerMTok);
  }
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
};

const scaledPrice = (price: number): bigint => BigInt(Math.round(price * PRICE_SCALE));

const toAmount = (units: bigint): number => {
  const whole = units / AMOUNT_DIVISOR;
  const fraction = (units % AMOUNT_DIVISOR).toString().padStart(AMOUNT_DIGITS, '0');
  return Number(`${whole}.${fraction}`);
};

export const findPriceEntry = (table: PriceTable, provider: string, model: string, atMs: number): PriceEntry | undefined =>
  table
    .filter((entry) => entry.provider === provider && entry.model === model && effectiveFromMs(entry) <= atMs)
    .reduce<PriceEntry | undefined>(
      (latest, entry) => (latest === undefined || effectiveFromMs(entry) > effectiveFromMs(latest) ? entry : latest),
      undefined,
    );

export const amountOfUnits = (units: bigint): number => toAmount(units);

export const LOCAL_PRICE_VERSION = 'local';

export const CACHE_READ_NOT_REPORTED_REASON = 'the upstream did not report the cache reads of the call';

export type CallBilling = 'metered' | 'local' | 'plan' | typeof UNKNOWN_BILLING;

export type PriceCallInput = CostInput & { billing: CallBilling; usageSource: UsageSource };

export type UnpricedPrice = { kind: 'unpriced' } & UnpricedOutcome;

export type PricedCall = { kind: 'priced'; units: bigint; currency: 'USD'; priceVersion: string } | UnpricedPrice;

export const isCacheReadNotReported = (price: PricedCall): boolean => price.kind === 'unpriced' && price.code === 'cache_read_not_reported';

const isCount = (value: number | undefined): boolean => value === undefined || (Number.isSafeInteger(value) && value >= 0);

export const priceCall = (input: PriceCallInput): PricedCall => {
  const { usage, billing } = input;
  const cached = usage.cachedInputTokens;
  const written = usage.cacheWriteInputTokens ?? 0;
  if (![usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens].every(isCount)) {
    return { kind: 'unpriced', code: 'unpriceable_usage', reason: 'a token count of the call is not a non-negative integer' };
  }
  if (cached !== undefined && cached + written > usage.inputTokens) {
    return { kind: 'unpriced', code: 'unpriceable_usage', reason: `cached input (${cached}) and written input (${written}) together exceed the input (${usage.inputTokens})` };
  }
  if (billing === UNKNOWN_BILLING) return { kind: 'unpriced', code: 'unknown_billing', reason: 'the billing of the target is unknown' };
  if (billing === 'local') return { kind: 'priced', units: 0n, currency: 'USD', priceVersion: LOCAL_PRICE_VERSION };
  if (billing === 'plan') return { kind: 'unpriced', code: 'plan', reason: 'plan' };
  if (Number.isNaN(input.at.getTime())) return { kind: 'unpriced', code: 'unpriceable_usage', reason: 'the time of the call is not a valid date' };
  if (input.usageSource === 'estimated') return { kind: 'unpriced', code: 'usage_not_reported', reason: 'the upstream reported no usage, so the usage on record is an estimate' };
  if (cached === undefined) return { kind: 'unpriced', code: 'cache_read_not_reported', reason: CACHE_READ_NOT_REPORTED_REASON };
  const entry = findPriceEntry(input.table, input.provider, input.model, input.at.getTime());
  if (entry === undefined) return { kind: 'unpriced', code: 'no_price_entry', reason: 'no price entry' };
  if (cached > 0 && entry.cachedInputPerMTok === undefined) {
    return { kind: 'unpriced', code: 'unpriceable_usage', reason: `${cached} cached input token(s) and the price entry has no cachedInputPerMTok` };
  }
  if (written > 0 && entry.cacheWritePerMTok === undefined) {
    return { kind: 'unpriced', code: 'unpriceable_usage', reason: `${written} cache write token(s) and the price entry has no cacheWritePerMTok` };
  }
  const units =
    BigInt(usage.inputTokens - cached - written) * scaledPrice(entry.inputPerMTok) +
    BigInt(cached) * scaledPrice(entry.cachedInputPerMTok ?? 0) +
    BigInt(written) * scaledPrice(entry.cacheWritePerMTok ?? 0) +
    BigInt(usage.outputTokens) * scaledPrice(entry.outputPerMTok);
  return { kind: 'priced', units, currency: entry.currency, priceVersion: entry.effectiveFrom };
};
