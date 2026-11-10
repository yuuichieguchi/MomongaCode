import { findPriceEntry } from '@momonga/observability';
import type { PriceTable } from '@momonga/observability';
import { admitRequest } from '@momonga/protocol';
import type { Admission, BudgetExhausted, TokenPrice } from '@momonga/protocol';
import type { GatewayChainMember } from '../gateway-client.ts';

export const OUTPUT_FLOOR_TOKENS = 256;

const PRICE_SCALE = 1_000_000_000;

const unitsOf = (perMTok: number): bigint => BigInt(Math.round(perMTok * PRICE_SCALE));

const larger = (left: bigint, right: bigint): bigint => (left > right ? left : right);

const memberPrice = (member: GatewayChainMember, table: PriceTable, atMs: number): TokenPrice | undefined => {
  const billed = member.billed;
  if (billed === undefined) return undefined;
  if (billed.billing === 'local') return { inUnits: 0n, outUnits: 0n };
  if (billed.billing !== 'metered' || billed.provider === undefined) return undefined;
  const entry = findPriceEntry(table, billed.provider, billed.upstream, atMs);
  if (entry === undefined) return undefined;
  return { inUnits: larger(unitsOf(entry.inputPerMTok), unitsOf(entry.cacheWritePerMTok ?? 0)), outUnits: unitsOf(entry.outputPerMTok) };
};

export const chainPrice = (chain: readonly GatewayChainMember[], table: PriceTable, atMs: number): TokenPrice | undefined => {
  let quoted: TokenPrice | undefined;
  for (const member of chain) {
    const price = memberPrice(member, table, atMs);
    if (price === undefined) return undefined;
    quoted = quoted === undefined ? price : { inUnits: larger(quoted.inUnits, price.inUnits), outUnits: larger(quoted.outUnits, price.outUnits) };
  }
  return quoted;
};

export type StepSize = { inputTokens: number; marginTokens: number; maxOutputTokens: number };

export type BudgetLimits = { maxTotalTokens?: number; maxCostNano?: number };

export type BudgetLedger = { admitModelRequest(ask: Parameters<typeof admitRequest>[0]): Admission | { kind: 'lease_lost' } };

export type StepAdmission = { kind: 'admitted'; maxOutputTokens: number } | { kind: 'exhausted'; exhausted: BudgetExhausted } | { kind: 'lease_lost' };

export type AdmitStep = { size: StepSize; limits: BudgetLimits; price: TokenPrice | undefined; unpricedCalls: number; spentNano: number; ledger: BudgetLedger };

export const admitStep = ({ size, limits, price, unpricedCalls, spentNano, ledger }: AdmitStep): StepAdmission => {
  if (limits.maxTotalTokens === undefined && limits.maxCostNano === undefined) return { kind: 'admitted', maxOutputTokens: size.maxOutputTokens };
  if (limits.maxCostNano !== undefined && unpricedCalls > 0) {
    return { kind: 'exhausted', exhausted: { dimension: 'cost', cause: 'unpriced', spent: spentNano, limit: limits.maxCostNano } };
  }
  const verdict = ledger.admitModelRequest({
    inputUpper: size.inputTokens + size.marginTokens,
    outputWanted: size.maxOutputTokens,
    outputFloor: OUTPUT_FLOOR_TOKENS,
    ...(price === undefined ? {} : { price }),
    limits: { ...(limits.maxTotalTokens === undefined ? {} : { tokens: limits.maxTotalTokens }), ...(limits.maxCostNano === undefined ? {} : { costNano: limits.maxCostNano }) },
  });
  if (verdict.kind === 'lease_lost') return verdict;
  if (verdict.kind === 'admitted') return { kind: 'admitted', maxOutputTokens: verdict.maxOutputTokens };
  const { kind: _refused, ...exhausted } = verdict;
  return { kind: 'exhausted', exhausted };
};

const DIMENSION_WORDS: Record<BudgetExhausted['dimension'], string> = { steps: 'steps', tokens: 'tokens', cost: 'money', time: 'time', retries: 'retries' };

export const exhaustedText = (exhausted: BudgetExhausted, format: (dimension: BudgetExhausted['dimension'], value: number) => string): string => {
  const what = DIMENSION_WORDS[exhausted.dimension];
  const figures = `${format(exhausted.dimension, exhausted.spent)} of ${format(exhausted.dimension, exhausted.limit)} used or reserved`;
  if (exhausted.cause === 'unpriced') return `The run stopped at its ${what} limit: a model call has no price, so its cost cannot be counted (${figures}).`;
  if (exhausted.cause === 'cap_too_small') return `The run stopped at its ${what} limit: what is left does not pay for another model request (${figures}).`;
  return `The run stopped at its ${what} limit (${figures}).`;
};
