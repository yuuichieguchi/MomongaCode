import { COST_CURRENCY, PRICE_DECIMAL_PLACES, priceEffectiveFromMs, validatePriceTable } from '@momonga/protocol';
import type { ModelQuote, RunCostView, UnpricedOutcome, UsageSource } from '@momonga/protocol';
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

const PRICE_SCALE = 10 ** PRICE_DECIMAL_PLACES;
const TOKENS_PER_MTOK_DIGITS = 6;
const AMOUNT_DIGITS = PRICE_DECIMAL_PLACES + TOKENS_PER_MTOK_DIGITS;
const AMOUNT_DIVISOR = 10n ** BigInt(AMOUNT_DIGITS);

const effectiveFromMs = priceEffectiveFromMs;

export const definePriceTable = (entries: readonly PriceEntry[]): PriceTable => {
  validatePriceTable(entries);
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
  if (billing === UNKNOWN_BILLING) return { kind: 'unpriced', code: 'unknown_billing', reason: 'the billing of the model is unknown' };
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

export type QuotedMember = { billing: string | undefined; provider: string | undefined; model: string };

type MemberPrice = { inUnits: bigint; outUnits: bigint; priceVersion: string };

const larger = (left: bigint, right: bigint): bigint => (left > right ? left : right);

const memberPriceOf = (member: QuotedMember, table: PriceTable, atMs: number): MemberPrice | undefined => {
  if (member.billing === 'local') return { inUnits: 0n, outUnits: 0n, priceVersion: LOCAL_PRICE_VERSION };
  if (member.billing !== 'metered' || member.provider === undefined) return undefined;
  const entry = findPriceEntry(table, member.provider, member.model, atMs);
  if (entry === undefined) return undefined;
  return {
    inUnits: [entry.inputPerMTok, entry.cacheWritePerMTok ?? 0, entry.cachedInputPerMTok ?? 0].map(scaledPrice).reduce(larger),
    outUnits: scaledPrice(entry.outputPerMTok),
    priceVersion: entry.effectiveFrom,
  };
};

export const quoteChain = (model: string, members: readonly QuotedMember[], table: PriceTable, atMs: number): ModelQuote => {
  const prices: MemberPrice[] = [];
  for (const member of members) {
    const price = memberPriceOf(member, table, atMs);
    if (price === undefined) return { model, priced: false };
    prices.push(price);
  }
  if (prices.length === 0) return { model, priced: false };
  return {
    model,
    priced: true,
    inUnits: prices.reduce((most, price) => larger(most, price.inUnits), 0n).toString(),
    outUnits: prices.reduce((most, price) => larger(most, price.outUnits), 0n).toString(),
    priceVersions: [...new Set(prices.map((price) => price.priceVersion))].sort(),
  };
};

export type RunCostCall = { runId: string; price: { kind: 'priced'; units: string; priceVersion: string } | { kind: 'unpriced' } | { kind: 'not_recorded' } };

type RunCostTally = { calls: number; notPriced: number; units: Map<string, bigint> };

export const runCostsOf = (runIds: readonly string[], calls: readonly RunCostCall[]): RunCostView[] => {
  const tallies = new Map<string, RunCostTally>(runIds.map((runId) => [runId, { calls: 0, notPriced: 0, units: new Map() }]));
  for (const call of calls) {
    const tally = tallies.get(call.runId);
    if (tally === undefined) throw new RangeError(`a billed call belongs to run ${call.runId}, which was not asked for`);
    tally.calls += 1;
    if (call.price.kind === 'priced') tally.units.set(call.price.priceVersion, (tally.units.get(call.price.priceVersion) ?? 0n) + BigInt(call.price.units));
    else tally.notPriced += 1;
  }
  return [...tallies].map(([runId, tally]) => ({
    runId,
    calls: tally.calls,
    notPriced: tally.notPriced,
    priced: [...tally.units]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([priceVersion, units]) => ({ currency: COST_CURRENCY, priceVersion, units: units.toString() })),
  }));
};
