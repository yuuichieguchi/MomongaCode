import { UNPRICED_CODES, UNPRICED_CODE_TEXT } from '@momonga/protocol';
import type { UnpricedCode } from '@momonga/protocol';
import { LOCAL_PRICE_VERSION, amountOfUnits } from './cost.ts';
import type { PricedCall } from './cost.ts';

export type MoneyTally = {
  calls: number;
  unpriced: Partial<Record<UnpricedCode, number>>;
  units: bigint;
  priceVersions: readonly string[];
};

const pricedCallsOf = (tally: MoneyTally): number => tally.calls - Object.values(tally.unpriced).reduce((sum, count) => sum + count, 0);

export const moneyTallyOf = (outcomes: readonly PricedCall[]): MoneyTally => {
  const unpriced: Partial<Record<UnpricedCode, number>> = {};
  const versions = new Set<string>();
  let units = 0n;
  for (const outcome of outcomes) {
    if (outcome.kind === 'unpriced') {
      unpriced[outcome.code] = (unpriced[outcome.code] ?? 0) + 1;
    } else {
      units += outcome.units;
      versions.add(outcome.priceVersion);
    }
  }
  return { calls: outcomes.length, unpriced, units, priceVersions: [...versions].sort() };
};

export const moneyAmountOf = (tally: MoneyTally): number | null => (tally.calls > 0 && pricedCallsOf(tally) === 0 ? null : amountOfUnits(tally.units));

export const describeMoney = (tally: MoneyTally): string => {
  const priced = pricedCallsOf(tally);
  const amount = `${amountOfUnits(tally.units)} USD`;
  if (tally.calls === 0) return 'no calls';
  const missing = UNPRICED_CODES.flatMap((code) => {
    const count = tally.unpriced[code];
    return count === undefined || count === 0 ? [] : [`${UNPRICED_CODE_TEXT[code]} in ${count} call(s)`];
  });
  if (missing.length > 0) {
    const part = priced === 0 ? '' : `; priced part: ${amount} over ${priced} of ${tally.calls} call(s)`;
    return `not complete: ${missing.join('; ')}${part}`;
  }
  const metered = tally.priceVersions.filter((version) => version !== LOCAL_PRICE_VERSION);
  if (metered.length === 0) return `${amount}, all ${tally.calls} call(s) ran locally and cost nothing`;
  return `${amount} at price version ${metered.join(',')}`;
};

export const moneyLine = (outcomes: readonly PricedCall[]): string => describeMoney(moneyTallyOf(outcomes));
