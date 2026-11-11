import { LEGACY_PRECISION_TEXT, PRICE_NOT_RECORDED, UNPRICED_CODES, UNPRICED_CODE_TEXT } from '@momonga/protocol';
import type { PriceNotRecorded, UnpricedCode } from '@momonga/protocol';
import { LOCAL_PRICE_VERSION, amountOfUnits } from './cost.ts';
import type { PricedCall } from './cost.ts';

export type MoneyTally = {
  calls: number;
  unpriced: Partial<Record<UnpricedCode, number>>;
  priceNotRecorded: number;
  amount: number | null;
  meteredPriceVersions: readonly string[];
  legacyPrecisionCalls: number;
};

const codedCallsOf = (unpriced: Partial<Record<UnpricedCode, number>>): number => Object.values(unpriced).reduce((sum, count) => sum + count, 0);

export const unpricedCallsOf = (unpriced: Partial<Record<UnpricedCode, number>>): number => codedCallsOf(unpriced);

export type LegacyPrecisionPrice = Extract<PricedCall, { kind: 'priced' }> & { legacyPrecision: true };

export type CallPrice = PricedCall | LegacyPrecisionPrice | PriceNotRecorded;

const pricedOf = (tally: Pick<MoneyTally, 'calls' | 'unpriced' | 'priceNotRecorded'>): number => tally.calls - codedCallsOf(tally.unpriced) - tally.priceNotRecorded;

export const moneyTallyOf = (outcomes: readonly CallPrice[]): MoneyTally => {
  const unpriced: Partial<Record<UnpricedCode, number>> = {};
  const versions = new Set<string>();
  let units = 0n;
  let priceNotRecorded = 0;
  let legacyPrecisionCalls = 0;
  for (const outcome of outcomes) {
    if (outcome.kind === 'not_recorded') {
      priceNotRecorded += 1;
    } else if (outcome.kind === 'unpriced') {
      unpriced[outcome.code] = (unpriced[outcome.code] ?? 0) + 1;
    } else {
      units += outcome.units;
      if ('legacyPrecision' in outcome) legacyPrecisionCalls += 1;
      if (outcome.priceVersion !== LOCAL_PRICE_VERSION) versions.add(outcome.priceVersion);
    }
  }
  return { calls: outcomes.length, unpriced, priceNotRecorded, amount: amountOfUnits(units), meteredPriceVersions: [...versions].sort(), legacyPrecisionCalls };
};

export const moneyAmountOf = (tally: MoneyTally): number | null => (tally.calls > 0 && pricedOf(tally) === 0 ? null : tally.amount);

const describeMoneyOf = (tally: MoneyTally): string => {
  if (tally.calls === 0) return 'no calls';
  const priced = pricedOf(tally);
  if (priced > 0 && tally.amount === null) throw new RangeError(`a scope with ${priced} priced call(s) has no amount`);
  const amount = `${tally.amount} USD`;
  const missing = UNPRICED_CODES.flatMap((code) => {
    const count = tally.unpriced[code] ?? 0;
    return count === 0 ? [] : [`${UNPRICED_CODE_TEXT[code]} in ${count} call(s)`];
  });
  if (tally.priceNotRecorded > 0) missing.push(`${PRICE_NOT_RECORDED} in ${tally.priceNotRecorded} call(s)`);
  if (missing.length > 0) {
    const part = priced === 0 ? '' : `; priced part: ${amount} over ${priced} of ${tally.calls} call(s)`;
    return `not complete: ${missing.join('; ')}${part}`;
  }
  if (tally.meteredPriceVersions.length === 0) return `${amount}, all ${tally.calls} call(s) ran locally and cost nothing`;
  return `${amount} at price version ${tally.meteredPriceVersions.join(',')}`;
};


export const describeMoney = (tally: MoneyTally): string => {
  const line = describeMoneyOf(tally);
  return tally.legacyPrecisionCalls === 0 ? line : `${line}; ${LEGACY_PRECISION_TEXT(tally.legacyPrecisionCalls)}`;
};
