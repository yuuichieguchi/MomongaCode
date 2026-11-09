import { amountOfUnits, priceCall } from '@momonga/observability';
import type { CallBilling, PriceTable } from '@momonga/observability';
import type { ModelCost, Usage } from '@momonga/protocol';

export type ModelCostInput = {
  provider: string;
  model: string;
  billing: CallBilling;
  usage: Usage;
  cacheWriteInputTokens: number | undefined;
  at: number;
  table: PriceTable;
};

export const modelCostOf = (input: ModelCostInput): ModelCost | null => {
  const priced = priceCall({
    provider: input.provider,
    model: input.model,
    billing: input.billing,
    usage: {
      inputTokens: input.usage.input_tokens,
      outputTokens: input.usage.output_tokens,
      ...(input.usage.input_tokens_details.cached_tokens === undefined ? {} : { cachedInputTokens: input.usage.input_tokens_details.cached_tokens }),
      ...(input.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: input.cacheWriteInputTokens }),
    },
    at: new Date(input.at),
    table: input.table,
  });
  if (priced.kind === 'unpriced') return null;
  return { amount: amountOfUnits(priced.units), currency: priced.currency, priceVersion: priced.priceVersion };
};
