import { admitRequest } from '@momonga/protocol';
import type { Admission, BudgetExhausted, ModelQuote, RequestBudget, TokenPrice } from '@momonga/protocol';

export const OUTPUT_FLOOR_TOKENS = 256;

export type StepSize = { inputTokens: number; marginTokens: number; maxOutputTokens: number; outputFloor?: number };

export type BudgetLimits = { maxTotalTokens: number; maxCostNano?: number };

export type BudgetLedger = { admitModelRequest(ask: Parameters<typeof admitRequest>[0]): Admission | { kind: 'lease_lost' } };

export type AdmittedStep = { kind: 'admitted'; maxOutputTokens: number; inputUpper: number; reservedTokens: number; reservedNano: number; costLimited: boolean };

export type StepAdmission = AdmittedStep | { kind: 'exhausted'; exhausted: BudgetExhausted } | { kind: 'lease_lost' };

export type AdmitStep = { size: StepSize; limits: BudgetLimits; price: TokenPrice | undefined; unpricedCalls: number; spentNano: number; ledger: BudgetLedger };

export const stepsExhausted = (step: number, maxSteps: number): BudgetExhausted | undefined =>
  step >= maxSteps ? { dimension: 'steps', cause: 'limit', spent: step, limit: maxSteps } : undefined;

export const admitStep = ({ size, limits, price, unpricedCalls, spentNano, ledger }: AdmitStep): StepAdmission => {
  if (limits.maxCostNano !== undefined && unpricedCalls > 0) {
    return { kind: 'exhausted', exhausted: { dimension: 'cost', cause: 'unpriced', spent: spentNano, limit: limits.maxCostNano } };
  }
  const inputUpper = size.inputTokens + size.marginTokens;
  const verdict = ledger.admitModelRequest({
    inputUpper,
    outputWanted: size.maxOutputTokens,
    outputFloor: size.outputFloor ?? OUTPUT_FLOOR_TOKENS,
    ...(price === undefined ? {} : { price }),
    limits: { tokens: limits.maxTotalTokens, ...(limits.maxCostNano === undefined ? {} : { costNano: limits.maxCostNano }) },
  });
  if (verdict.kind === 'lease_lost') return verdict;
  if (verdict.kind === 'admitted') {
    return { kind: 'admitted', maxOutputTokens: verdict.maxOutputTokens, inputUpper, reservedTokens: verdict.reservedTokens, reservedNano: verdict.reservedNano, costLimited: limits.maxCostNano !== undefined };
  }
  const { kind: _refused, ...exhausted } = verdict;
  return { kind: 'exhausted', exhausted };
};

export const requestBudgetOf = (admitted: AdmittedStep, quote: ModelQuote | undefined): RequestBudget => ({
  reservedTokens: admitted.reservedTokens,
  maxOutputTokens: admitted.maxOutputTokens,
  ...(admitted.costLimited ? { reservedNano: admitted.reservedNano } : {}),
  ...(quote === undefined || !quote.priced ? {} : { quote: { inUnits: quote.inUnits, outUnits: quote.outUnits, priceVersions: quote.priceVersions } }),
});

const DIMENSION_WORDS: Record<BudgetExhausted['dimension'], string> = { steps: 'step', tokens: 'token', cost: 'money', time: 'time', retries: 'retry' };

export const exhaustedText = (exhausted: BudgetExhausted, format: (dimension: BudgetExhausted['dimension'], value: number) => string): string => {
  const what = DIMENSION_WORDS[exhausted.dimension];
  const figures = `${format(exhausted.dimension, exhausted.spent)} of ${format(exhausted.dimension, exhausted.limit)} used or reserved`;
  if (exhausted.cause === 'unpriced') return `The run stopped at its ${what} limit: a model call has no price, so its cost cannot be counted (${figures}).`;
  if (exhausted.cause === 'cap_too_small') {
    const admits = exhausted.admitsAt === undefined ? '' : ` A budget of ${format(exhausted.dimension, exhausted.admitsAt)} admits the next model request.`;
    return `The run stopped at its ${what} limit: what is left does not pay for another model request (${figures}).${admits}`;
  }
  return `The run stopped at its ${what} limit (${figures}).`;
};

export const unpaidText = (exhausted: BudgetExhausted, format: (dimension: BudgetExhausted['dimension'], value: number) => string): string => {
  const what = DIMENSION_WORDS[exhausted.dimension];
  if (exhausted.cause === 'unpriced') return `its model has no price, so its cost cannot be counted under the ${what} limit of the run`;
  return `${format(exhausted.dimension, exhausted.spent)} of ${format(exhausted.dimension, exhausted.limit)} of the ${what} limit of the run are used or reserved`;
};
