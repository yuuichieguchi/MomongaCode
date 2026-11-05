import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { FunctionTool, InputItem } from '@momonga/protocol';
import type { DeepReadonly, ItemCountContext, MeterCount, MeterRequest, TokenMeter } from '@momonga/context';

export const weightOf = (item: DeepReadonly<InputItem>): number => canonicalJson(item).length;

export const weightOfAll = (items: readonly DeepReadonly<InputItem>[]): number => items.reduce((sum, item) => sum + weightOf(item), 0);

export const toolWeightOf = (tools: readonly FunctionTool[]): number => tools.reduce((sum, tool) => sum + canonicalJson(tool).length, 0);

export type UnderRule = (tokens: number) => number;

export type WeightMeter = TokenMeter & { requests: MeterRequest[]; itemCounts: { item: InputItem; context: ItemCountContext }[]; under: UnderRule };

export const weightMeter = (under: UnderRule = () => 0): WeightMeter => {
  const requests: MeterRequest[] = [];
  const itemCounts: { item: InputItem; context: ItemCountContext }[] = [];
  const meter: WeightMeter = {
    requests,
    itemCounts,
    under,
    count: async (request) => {
      requests.push(request);
      const inputTokens = weightOfAll(request.input) + toolWeightOf(request.tools);
      const counted: MeterCount = {
        inputTokens,
        freshInputTokens: inputTokens,
        inputDigest: sha256Hex(canonicalJson({ input: request.input, tools: request.tools })),
        known: 0,
        uncounted: inputTokens,
        overTolerance: 0,
        underAt: (tokens) => meter.under(tokens),
        freshUnderAt: (tokens) => meter.under(tokens),
      };
      return counted;
    },
    countItem: async (item, context) => {
      itemCounts.push({ item, context });
      return weightOf(item);
    },
    observe: () => {
      throw new Error('the weight meter observes no reports');
    },
    restore: () => undefined,
  };
  return meter;
};
