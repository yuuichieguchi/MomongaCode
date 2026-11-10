export const BUDGET_DIMENSIONS = ['steps', 'tokens', 'cost', 'time', 'retries'] as const;

export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

export const BUDGET_CAUSES = ['limit', 'unpriced', 'cap_too_small'] as const;

export type BudgetCause = (typeof BUDGET_CAUSES)[number];

export type BudgetExhausted = { dimension: BudgetDimension; cause: BudgetCause; spent: number; limit: number };

export const NANO_PER_USD = 1_000_000_000;

export const MAX_COST_USD = 1_000_000;

const AMOUNT_DIGITS = 15;
const NANO_DIGITS = 9;

export const nanoOfAmount = (amount: number): number => {
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError(`an amount of money must be a non-negative finite number, got ${amount}`);
  const [whole, fraction = ''] = amount.toFixed(AMOUNT_DIGITS).split('.');
  const kept = BigInt(`${whole}${fraction.slice(0, NANO_DIGITS)}`);
  const beyondExactDigits = amount * 10 ** AMOUNT_DIGITS >= Number.MAX_SAFE_INTEGER;
  const nano = kept + (/[1-9]/.test(fraction.slice(NANO_DIGITS)) ? 1n : 0n) + (beyondExactDigits ? 1n : 0n);
  if (nano > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`an amount of ${amount} USD is beyond what the budget can count`);
  return Number(nano);
};

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

export const QUIESCENT_EXIT_CODE = 75;

export const PRICE_UNITS_PER_NANO = 1_000_000n;

export type TokenPrice = { inUnits: bigint; outUnits: bigint };

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

const ceilDiv = (value: bigint, divisor: bigint): bigint => (value + divisor - 1n) / divisor;

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
    reservedNano = Number(ceilDiv(inputUnits + BigInt(cap) * ask.price.outUnits, PRICE_UNITS_PER_NANO));
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
