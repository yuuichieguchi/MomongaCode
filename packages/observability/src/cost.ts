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

export type Cost = { amount: number; currency: 'USD'; priceVersion: string };

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

const assertTokenCount = (field: string, tokens: number): void => {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new RangeError(`${field} must be a non-negative integer, got ${tokens}`);
  }
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

export type CostUnits = { units: bigint; currency: 'USD'; priceVersion: string };

export const amountOfUnits = (units: bigint): number => toAmount(units);

export const computeCostUnits = (input: CostInput): CostUnits | null => {
  const { usage } = input;
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheWriteInputTokens = usage.cacheWriteInputTokens ?? 0;
  assertTokenCount('inputTokens', usage.inputTokens);
  assertTokenCount('outputTokens', usage.outputTokens);
  assertTokenCount('cachedInputTokens', cachedInputTokens);
  assertTokenCount('cacheWriteInputTokens', cacheWriteInputTokens);
  if (cachedInputTokens + cacheWriteInputTokens > usage.inputTokens) {
    throw new RangeError(
      `cachedInputTokens (${cachedInputTokens}) and cacheWriteInputTokens (${cacheWriteInputTokens}) together exceed inputTokens (${usage.inputTokens})`,
    );
  }
  const atMs = input.at.getTime();
  if (Number.isNaN(atMs)) throw new RangeError('computeCost: at must be a valid Date');
  const entry = findPriceEntry(input.table, input.provider, input.model, atMs);
  if (entry === undefined) return null;
  let cacheWriteUnits = 0n;
  if (cacheWriteInputTokens > 0) {
    if (entry.cacheWritePerMTok === undefined) return null;
    cacheWriteUnits = BigInt(cacheWriteInputTokens) * scaledPrice(entry.cacheWritePerMTok);
  }
  const inputRate = scaledPrice(entry.inputPerMTok);
  const cachedRate = scaledPrice(entry.cachedInputPerMTok ?? entry.inputPerMTok);
  const outputRate = scaledPrice(entry.outputPerMTok);
  const units =
    BigInt(usage.inputTokens - cachedInputTokens - cacheWriteInputTokens) * inputRate +
    BigInt(cachedInputTokens) * cachedRate +
    cacheWriteUnits +
    BigInt(usage.outputTokens) * outputRate;
  return { units, currency: entry.currency, priceVersion: entry.effectiveFrom };
};

export const computeCost = (input: CostInput): Cost | null => {
  const priced = computeCostUnits(input);
  return priced === null ? null : { amount: toAmount(priced.units), currency: priced.currency, priceVersion: priced.priceVersion };
};
