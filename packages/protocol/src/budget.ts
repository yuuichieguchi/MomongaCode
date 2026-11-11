export const BUDGET_DIMENSIONS = ['steps', 'tokens', 'cost', 'time', 'retries'] as const;

export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

export const BUDGET_CAUSES = ['limit', 'unpriced', 'cap_too_small'] as const;

export type BudgetCause = (typeof BUDGET_CAUSES)[number];

export type BudgetExhausted = { dimension: BudgetDimension; cause: BudgetCause; spent: number; limit: number };

export const NANO_PER_USD = 1_000_000_000;

export const MAX_COST_USD = 1_000_000;

const NANO_DIGITS = 9;
const UNIT_DIGITS_BELOW_NANO = 6;
const LARGEST_DECIMAL_SHIFT = 32;

const DECIMAL_TEXT = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

const ceilDiv = (value: bigint, divisor: bigint): bigint => (value + divisor - 1n) / divisor;

const countedNano = (nano: bigint, shown: string): number => {
  if (nano > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`an amount of ${shown} USD is beyond what the budget can count`);
  return Number(nano);
};

export const nanoOfDecimal = (text: string): number => {
  const parsed = DECIMAL_TEXT.exec(text);
  if (parsed === null) throw new RangeError(`an amount of money must be a non-negative decimal number, got ${text}`);
  const [, whole = '', fraction = '', exponent = '0'] = parsed;
  const digits = BigInt(`${whole}${fraction}`);
  if (digits === 0n) return 0;
  const shift = NANO_DIGITS + Number(exponent) - fraction.length;
  if (shift > LARGEST_DECIMAL_SHIFT) throw new RangeError(`an amount of ${text} USD is beyond what the budget can count`);
  return countedNano(shift >= 0 ? digits * 10n ** BigInt(shift) : ceilDiv(digits, 10n ** BigInt(-shift)), text);
};

export const nanoOfAmount = (amount: number): number => {
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError(`an amount of money must be a non-negative finite number, got ${amount}`);
  return nanoOfDecimal(String(amount));
};

export const nanoOfUnits = (units: string): number => {
  if (!/^\d+$/.test(units)) throw new RangeError(`price units must be a non-negative whole number, got ${units}`);
  return countedNano(ceilDiv(BigInt(units), 10n ** BigInt(UNIT_DIGITS_BELOW_NANO)), `${units} price units`);
};

export const nanoOfCost = (cost: { amount: number; units?: string }): number => (cost.units === undefined ? nanoOfAmount(cost.amount) : nanoOfUnits(cost.units));

export const usdOfNano = (nano: number): string => {
  const whole = Math.trunc(nano / NANO_PER_USD);
  const fraction = String(nano % NANO_PER_USD).padStart(NANO_DIGITS, '0').replace(/0+$/, '');
  return fraction === '' ? String(whole) : `${whole}.${fraction}`;
};

export type RunUsage = { inputTokens: number; outputTokens: number; totalTokens: number; costNano?: number; unpricedCalls?: number };

export type CallFootprint = { reads: string[]; writes: string[] };

export type HeldCallView = { callId: string; approvalId: string; tool: string; reason: string; sinceSeq: number };

export const HELD_OUTCOMES = ['executed', 'rejected', 'withdrawn'] as const;

export type HeldOutcome = (typeof HELD_OUTCOMES)[number];

export const PRICE_UNITS_PER_NANO = 1_000_000n;

export type TokenPrice = { inUnits: bigint; outUnits: bigint };

export type ModelQuote = { model: string; priced: true; inUnits: string; outUnits: string; priceVersions: string[] } | { model: string; priced: false };

export const QUOTE_ROUTE = '/v1/momonga/quote';

export const BUDGET_EXCEEDED_CODE = 'budget_exceeded';

export const tokenPriceOfQuote = (quote: ModelQuote): TokenPrice | undefined => (quote.priced ? { inUnits: BigInt(quote.inUnits), outUnits: BigInt(quote.outUnits) } : undefined);

export const worstCaseUnits = (inputUpper: number, outputCap: number, price: TokenPrice): bigint => BigInt(inputUpper) * price.inUnits + BigInt(outputCap) * price.outUnits;

export const fitsCostCeiling = (inputUpper: number, outputCap: number, price: TokenPrice, ceilingNano: number): boolean =>
  worstCaseUnits(inputUpper, outputCap, price) <= BigInt(ceilingNano) * PRICE_UNITS_PER_NANO;

export type RequestBudget = { reservedTokens: number; reservedNano?: number; maxOutputTokens: number; quote?: { inUnits: string; outUnits: string; priceVersions: string[] } };

export type TreeSpend = { totalTokens: number; costNano: number; unpricedCalls: number; reservedTokens: number; reservedNano: number };

export type AdmissionAsk = {
  inputUpper: number;
  outputWanted: number;
  outputFloor: number;
  price?: TokenPrice;
  limits: { tokens?: number; costNano?: number };
};

export type Admission =
  | { kind: 'admitted'; maxOutputTokens: number; reservedTokens: number; reservedNano: number }
  | ({ kind: 'refused' } & BudgetExhausted);

const safeNumber = (value: bigint): number => (value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value));

const refusalOf = (dimension: BudgetDimension, spent: number, limit: number): Admission => ({ kind: 'refused', dimension, cause: spent >= limit ? 'limit' : 'cap_too_small', spent, limit });

export const admitRequest = (ask: AdmissionAsk, spend: TreeSpend): Admission => {
  const floor = Math.min(ask.outputWanted, ask.outputFloor);
  let cap = ask.outputWanted;
  if (ask.limits.tokens !== undefined) {
    const held = spend.totalTokens + spend.reservedTokens;
    const room = ask.limits.tokens - held - ask.inputUpper;
    if (room < floor) return refusalOf('tokens', held, ask.limits.tokens);
    cap = Math.min(cap, room);
  }
  let reservedNano = 0;
  if (ask.limits.costNano !== undefined) {
    if (ask.price === undefined) return { kind: 'refused', dimension: 'cost', cause: 'unpriced', spent: spend.costNano + spend.reservedNano, limit: ask.limits.costNano };
    const held = spend.costNano + spend.reservedNano;
    const availableUnits = BigInt(ask.limits.costNano - held) * PRICE_UNITS_PER_NANO;
    const inputUnits = BigInt(ask.inputUpper) * ask.price.inUnits;
    const outputRoom = availableUnits - inputUnits;
    if (outputRoom < 0n) return refusalOf('cost', held, ask.limits.costNano);
    if (ask.price.outUnits > 0n) {
      const fitting = safeNumber(outputRoom / ask.price.outUnits);
      if (fitting < floor) return refusalOf('cost', held, ask.limits.costNano);
      cap = Math.min(cap, fitting);
    }
    reservedNano = Number(ceilDiv(worstCaseUnits(ask.inputUpper, cap, ask.price), PRICE_UNITS_PER_NANO));
  }
  return { kind: 'admitted', maxOutputTokens: cap, reservedTokens: ask.inputUpper + cap, reservedNano };
};

export type ComposedBudget = { steps?: number; tokens?: number; costUsd?: number; timeMs?: number; retries?: number };

const lesser = (declared: number | undefined, ceiling: number | undefined): number | undefined =>
  declared === undefined ? ceiling : ceiling === undefined ? declared : Math.min(declared, ceiling);

export const composeBudget = (declared: ComposedBudget, ceilings: Pick<ComposedBudget, 'tokens' | 'costUsd' | 'timeMs'>): ComposedBudget => {
  const tokens = lesser(declared.tokens, ceilings.tokens);
  const costUsd = lesser(declared.costUsd, ceilings.costUsd);
  const timeMs = lesser(declared.timeMs, ceilings.timeMs);
  return {
    ...(declared.steps === undefined ? {} : { steps: declared.steps }),
    ...(tokens === undefined ? {} : { tokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(timeMs === undefined ? {} : { timeMs }),
    ...(declared.retries === undefined ? {} : { retries: declared.retries }),
  };
};
