import { amountOfUnits, priceCall } from '@momonga/observability';
import type { CallBilling, PriceTable } from '@momonga/observability';
import type { ModelCost, ModelPricing, UnpricedOutcome, Usage, UsageSource } from '@momonga/protocol';

export type ModelCostInput = {
  provider: string;
  model: string;
  billing: CallBilling;
  usage: Usage;
  usageSource: UsageSource;
  cacheWriteInputTokens: number | undefined;
  at: number;
  table: PriceTable | undefined;
};

export const NO_PRICE_TABLE_REASON = 'no price table';

export const modelCostOf = (input: ModelCostInput): ModelPricing => {
  const priced = priceCall({
    provider: input.provider,
    model: input.model,
    billing: input.billing,
    usageSource: input.usageSource,
    usage: {
      inputTokens: input.usage.input_tokens,
      outputTokens: input.usage.output_tokens,
      ...(input.usage.input_tokens_details.cached_tokens === undefined ? {} : { cachedInputTokens: input.usage.input_tokens_details.cached_tokens }),
      ...(input.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: input.cacheWriteInputTokens }),
    },
    at: new Date(input.at),
    table: input.table ?? [],
  });
  if (priced.kind === 'unpriced') return { kind: 'unpriced', code: priced.code, reason: priced.code === 'no_price_entry' && input.table === undefined ? NO_PRICE_TABLE_REASON : priced.reason };
  return { kind: 'priced', cost: { amount: amountOfUnits(priced.units), currency: priced.currency, priceVersion: priced.priceVersion } };
};

export const pricingFieldsOf = (pricing: ModelPricing): { cost: ModelCost } | { unpriced: UnpricedOutcome } =>
  pricing.kind === 'priced' ? { cost: pricing.cost } : { unpriced: { code: pricing.code, reason: pricing.reason } };
